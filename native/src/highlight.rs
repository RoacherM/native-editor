//! Multi-line TextMate syntax highlighter (`syntect` + `two-face`) for Aed's
//! code editor. Parses off the UI thread and emits compact UTF-16 column quads
//! `[line, start_col, end_col, role]` (`1..=10`) mapped onto `EditorTheme.syntax`.
//! DESIGN.md「文件预览与 Mermaid 渲染契约」.

use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

pub const ROLE_COMMENT: u32 = 1;
pub const ROLE_KEYWORD: u32 = 2;
pub const ROLE_STRING: u32 = 3;
pub const ROLE_NUMBER: u32 = 4;
pub const ROLE_FUNCTION: u32 = 5;
pub const ROLE_TYPE: u32 = 6;
pub const ROLE_CONSTANT: u32 = 7;
pub const ROLE_PROPERTY: u32 = 8;
pub const ROLE_OPERATOR: u32 = 9;
pub const ROLE_TAG: u32 = 10;

const MAX_DECORATIONS: usize = 16_000;
const MAX_LINE_BYTES: usize = 4_096;

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeClass {
    /// Stops outer `string` scopes from leaking into `${...}` / `{...}` interpolations.
    Barrier,
    Role(u32),
    /// `variable.parameter`: `self` / `cls` -> Constant, other params/kwargs -> Property.
    ParamOrSelf,
    /// `keyword.operator`: alphabetic words (`and`, `in`, `typeof`) -> Keyword, symbols -> Operator.
    OperatorOrWord,
    /// Generic `storage.type`: declaring words (`let`, `def`, `fn`) -> Keyword, else Type.
    StorageType,
}

#[derive(Debug, Clone, Copy, Default)]
struct ScopeMeta {
    class: Option<ScopeClass>,
    /// `Some(true)` on `meta.mapping.key` / `meta.object-literal.key`, `Some(false)` on `.value`.
    mapping_key: Option<bool>,
    is_accessor_dot: bool,
    is_generic_ident: bool,
}

thread_local! {
    static SCOPE_CACHE: RefCell<HashMap<Scope, ScopeMeta>> = RefCell::default();
}

const PLAIN_LANGS: &[&str] = &["", "text", "txt", "plain", "plaintext", "binary", "csv", "tsv"];

const LANG_ALIASES: &[(&str, &str)] = &[
    ("python", "py"),
    ("typescript", "ts"),
    ("tsx", "tsx"),
    ("javascript", "js"),
    ("jsx", "tsx"),
    ("mjs", "js"),
    ("cjs", "js"),
    ("bash", "sh"),
    ("zsh", "sh"),
    ("shell", "sh"),
    ("shellscript", "sh"),
    ("console", "sh"),
    ("dockerfile", "Dockerfile"),
    ("docker", "Dockerfile"),
    ("makefile", "Makefile"),
    ("make", "Makefile"),
    ("jsonl", "json"),
    ("ndjson", "json"),
    ("jsonc", "json"),
    ("json5", "json"),
    ("golang", "go"),
    ("c++", "cpp"),
    ("csharp", "cs"),
    ("c#", "cs"),
    ("fsharp", "fs"),
    ("f#", "fs"),
    ("objc", "m"),
    ("objective-c", "m"),
    ("dotenv", "sh"),
    ("vue", "html"),
    ("svelte", "html"),
];

const DECLARING_WORDS: &[&str] = &[
    "let", "const", "var", "static", "mut", "fn", "func", "function", "def", "lambda",
    "class", "struct", "enum", "union", "trait", "impl", "type", "interface", "module",
    "mod", "namespace", "typedef", "val", "extern", "async",
];

/// Ordered prefix rules: the first matching prefix wins for a single `Scope` atom.
const SCOPE_RULES: &[(&str, ScopeClass)] = &[
    // 1. Comments & Python docstrings (precedes generic `string`).
    ("comment", ScopeClass::Role(ROLE_COMMENT)),
    ("punctuation.definition.comment", ScopeClass::Role(ROLE_COMMENT)),
    ("string.quoted.docstring", ScopeClass::Role(ROLE_COMMENT)),
    // 2. Interpolation delimiters, decorators/annotations & barriers.
    ("punctuation.section.interpolation", ScopeClass::Role(ROLE_OPERATOR)),
    ("punctuation.section.embedded", ScopeClass::Role(ROLE_OPERATOR)),
    ("punctuation.definition.template-expression", ScopeClass::Role(ROLE_OPERATOR)),
    ("punctuation.separator.annotation.result", ScopeClass::Role(ROLE_OPERATOR)),
    ("punctuation.separator.annotation.return", ScopeClass::Role(ROLE_OPERATOR)),
    ("punctuation.definition.decorator", ScopeClass::Role(ROLE_PROPERTY)),
    ("punctuation.definition.annotation", ScopeClass::Role(ROLE_PROPERTY)),
    ("punctuation.definition.variable", ScopeClass::Role(ROLE_PROPERTY)),
    ("meta.interpolation", ScopeClass::Barrier),
    ("meta.template.expression", ScopeClass::Barrier),
    ("meta.embedded", ScopeClass::Barrier),
    // 3. Escapes, numbers & language constants (`True`, `None`, `self`, `this`).
    ("constant.character.escape", ScopeClass::Role(ROLE_CONSTANT)),
    ("constant.numeric", ScopeClass::Role(ROLE_NUMBER)),
    ("constant.language", ScopeClass::Role(ROLE_CONSTANT)),
    ("constant.character", ScopeClass::Role(ROLE_CONSTANT)),
    ("constant.other", ScopeClass::Role(ROLE_CONSTANT)),
    ("support.constant", ScopeClass::Role(ROLE_CONSTANT)),
    ("variable.language", ScopeClass::Role(ROLE_CONSTANT)),
    // 4. Properties, keys, attributes & parameters (precedes `support.type` / `entity.name.tag`).
    ("support.type.property-name", ScopeClass::Role(ROLE_PROPERTY)),
    ("support.variable.property", ScopeClass::Role(ROLE_PROPERTY)),
    ("entity.other.attribute-name", ScopeClass::Role(ROLE_PROPERTY)),
    ("entity.name.tag.yaml", ScopeClass::Role(ROLE_PROPERTY)),
    ("entity.name.tag.toml", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.member", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.property", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.object.property", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.readwrite.attr", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.readwrite.shell", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.positional.shell", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.other.special.shell", ScopeClass::Role(ROLE_PROPERTY)),
    ("variable.parameter", ScopeClass::ParamOrSelf),
    // 5. Functions, methods, macros & decorators/annotations.
    ("entity.name.function", ScopeClass::Role(ROLE_FUNCTION)),
    ("variable.function", ScopeClass::Role(ROLE_FUNCTION)),
    ("variable.annotation", ScopeClass::Role(ROLE_FUNCTION)),
    ("support.function", ScopeClass::Role(ROLE_FUNCTION)),
    ("support.macro", ScopeClass::Role(ROLE_FUNCTION)),
    ("meta.function-call.generic", ScopeClass::Role(ROLE_FUNCTION)),
    ("meta.decorator", ScopeClass::Role(ROLE_FUNCTION)),
    // 6. Markup tags & TOML/Markdown sections.
    ("entity.name.tag", ScopeClass::Role(ROLE_TAG)),
    ("entity.name.section", ScopeClass::Role(ROLE_TAG)),
    ("entity.name.table", ScopeClass::Role(ROLE_TAG)),
    ("markup.heading", ScopeClass::Role(ROLE_TAG)),
    // 7. Types, classes, structs, traits & TSX components (`support.class.component`).
    ("entity.name.type", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.class", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.struct", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.enum", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.trait", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.union", ScopeClass::Role(ROLE_TYPE)),
    ("entity.name.impl", ScopeClass::Role(ROLE_TYPE)),
    ("entity.other.inherited-class", ScopeClass::Role(ROLE_TYPE)),
    ("support.type", ScopeClass::Role(ROLE_TYPE)),
    ("support.class", ScopeClass::Role(ROLE_TYPE)),
    // 8. Keywords, word/symbolic operators & storage specifiers.
    ("keyword.operator", ScopeClass::OperatorOrWord),
    ("keyword", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.modifier", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.function", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.class", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.struct", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.enum", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.trait", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.interface", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.type", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.impl", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.def", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.fn", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type.string", ScopeClass::Role(ROLE_KEYWORD)),
    ("storage.type", ScopeClass::StorageType),
    ("storage", ScopeClass::Role(ROLE_KEYWORD)),
    // 9. Strings & diff markup.
    ("string", ScopeClass::Role(ROLE_STRING)),
    ("markup.inserted", ScopeClass::Role(ROLE_STRING)),
    ("markup.deleted", ScopeClass::Role(ROLE_KEYWORD)),
];

pub fn syntaxes() -> &'static SyntaxSet {
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

fn resolve_alias(lower: &str) -> &str {
    LANG_ALIASES
        .iter()
        .find(|&&(k, _)| k == lower)
        .map_or(lower, |&(_, v)| v)
}

pub fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
    let trimmed = language.trim();
    let lower = trimmed.to_ascii_lowercase();
    if PLAIN_LANGS.contains(&lower.as_str()) {
        return None;
    }
    let set = syntaxes();
    set.find_syntax_by_token(resolve_alias(&lower))
        .or_else(|| set.find_syntax_by_token(trimmed))
        .filter(|syn| syn.name != "Plain Text")
}

fn has_scope_prefix(scope: &str, prefix: &str) -> bool {
    scope
        .strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

fn compute_mapping_key_flag(text: &str) -> Option<bool> {
    if has_scope_prefix(text, "meta.mapping.key")
        || has_scope_prefix(text, "meta.object-literal.key")
    {
        return Some(true);
    }
    has_scope_prefix(text, "meta.mapping.value").then_some(false)
}

fn compute_scope_meta(scope: Scope) -> ScopeMeta {
    let text = scope.build_string();
    let class = SCOPE_RULES
        .iter()
        .find(|&&(prefix, _)| has_scope_prefix(&text, prefix))
        .map(|&(_, c)| c);
    ScopeMeta {
        class,
        mapping_key: compute_mapping_key_flag(&text),
        is_accessor_dot: has_scope_prefix(&text, "punctuation.accessor"),
        is_generic_ident: has_scope_prefix(&text, "meta.generic-name")
            || has_scope_prefix(&text, "meta.annotation.parameters"),
    }
}

fn role_for_ambiguous(class: ScopeClass, trimmed: &str) -> u32 {
    match class {
        ScopeClass::ParamOrSelf => {
            if matches!(trimmed, "self" | "cls") { ROLE_CONSTANT } else { ROLE_PROPERTY }
        }
        ScopeClass::OperatorOrWord => {
            if trimmed.bytes().all(|b| b.is_ascii_alphabetic()) {
                ROLE_KEYWORD
            } else {
                ROLE_OPERATOR
            }
        }
        ScopeClass::StorageType => {
            if DECLARING_WORDS.contains(&trimmed) { ROLE_KEYWORD } else { ROLE_TYPE }
        }
        ScopeClass::Barrier => 0,
        ScopeClass::Role(r) => r,
    }
}

fn settle_class(class: ScopeClass, token_text: &str) -> u32 {
    let trimmed = token_text.trim();
    if trimmed.is_empty() {
        return match class {
            ScopeClass::Role(r) if r == ROLE_COMMENT || r == ROLE_STRING => r,
            _ => 0,
        };
    }
    role_for_ambiguous(class, trimmed)
}

fn is_pascal_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();
    let head_ok = bytes.first().is_some_and(u8::is_ascii_uppercase);
    let body_ok = bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_');
    head_ok && body_ok && bytes.iter().any(u8::is_ascii_lowercase)
}

fn is_screaming_constant(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_uppercase()
        && bytes.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

fn classify_generic_ident(trimmed: &str, after_dot: bool) -> u32 {
    if is_pascal_identifier(trimmed) {
        return ROLE_TYPE;
    }
    if is_screaming_constant(trimmed) {
        return ROLE_CONSTANT;
    }
    if after_dot && trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return ROLE_PROPERTY;
    }
    0
}

struct TokenScanOutcome {
    role: u32,
    is_dot: bool,
}

fn resolve_token(scopes: &ScopeStack, token_text: &str, after_dot: bool) -> TokenScanOutcome {
    let (matched_class, mapping_key, is_dot, is_generic) = SCOPE_CACHE.with_borrow_mut(|cache| {
        let mut class = None;
        let mut key_flag = None;
        let mut dot = false;
        let mut generic = false;
        for &sc in scopes.as_slice().iter().rev() {
            let meta = *cache.entry(sc).or_insert_with(|| compute_scope_meta(sc));
            if class.is_none() {
                class = meta.class;
            }
            if key_flag.is_none() {
                key_flag = meta.mapping_key;
            }
            dot |= meta.is_accessor_dot;
            generic |= meta.is_generic_ident;
        }
        (class, key_flag, dot, generic)
    });

    let mut role = matched_class.map_or(0, |c| settle_class(c, token_text));
    if role == ROLE_STRING && mapping_key == Some(true) {
        role = ROLE_PROPERTY;
    } else if role == 0 && is_generic {
        role = classify_generic_ident(token_text.trim(), after_dot);
    }
    TokenScanOutcome { role, is_dot }
}

fn utf16_col(line: &str, byte_idx: usize, ascii: bool) -> u32 {
    if ascii {
        byte_idx as u32
    } else {
        line[..byte_idx].encode_utf16().count() as u32
    }
}

fn emit_span(out: &mut Vec<u32>, line_idx: u32, start_col: u32, end_col: u32, role: u32) {
    if role == 0 || start_col >= end_col || out.len() + 4 > MAX_DECORATIONS * 4 {
        return;
    }
    let len = out.len();
    if len >= 4 && out[len - 4] == line_idx && out[len - 2] == start_col && out[len - 1] == role {
        out[len - 2] = end_col;
        return;
    }
    out.extend_from_slice(&[line_idx, start_col, end_col, role]);
}

struct LineEmitCtx<'a> {
    content: &'a str,
    ascii: bool,
    line_idx: u32,
    after_dot: bool,
}

fn emit_segment(
    ctx: &mut LineEmitCtx<'_>,
    scopes: &ScopeStack,
    start: usize,
    end: usize,
    out: &mut Vec<u32>,
) {
    if start >= end {
        return;
    }
    let slice = &ctx.content[start..end];
    let outcome = resolve_token(scopes, slice, ctx.after_dot);
    emit_span(
        out,
        ctx.line_idx,
        utf16_col(ctx.content, start, ctx.ascii),
        utf16_col(ctx.content, end, ctx.ascii),
        outcome.role,
    );
    if !slice.trim().is_empty() {
        ctx.after_dot = outcome.is_dot;
    }
}

fn parse_single_line(
    parser: &mut ParseState,
    scopes: &mut ScopeStack,
    line_with_nl: &str,
    content_len: usize,
    line_idx: u32,
    set: &SyntaxSet,
    out: &mut Vec<u32>,
) {
    if content_len > MAX_LINE_BYTES {
        return;
    }
    let Ok(ops) = parser.parse_line(line_with_nl, set) else {
        return;
    };
    let content = &line_with_nl[..content_len];
    let mut ctx = LineEmitCtx {
        content,
        ascii: content.is_ascii(),
        line_idx,
        after_dot: false,
    };
    let mut cursor = 0usize;
    for (idx, op) in ops {
        emit_segment(&mut ctx, scopes, cursor, idx.min(content_len), out);
        let _ = scopes.apply(&op);
        cursor = idx;
    }
    emit_segment(&mut ctx, scopes, cursor, content_len, out);
}

pub fn parse(text: &str, language: &str, max_lines: usize) -> Vec<u32> {
    if text.is_empty() || max_lines == 0 {
        return Vec::new();
    }
    let Some(syntax) = find_syntax(language) else {
        return Vec::new();
    };
    let set = syntaxes();
    let mut parser = ParseState::new(syntax);
    let mut scopes = ScopeStack::new();
    let mut out = Vec::with_capacity(text.len().min(4096));
    let mut tail_buf = String::new();

    for (line_idx, raw_slice) in text.split_inclusive('\n').take(max_lines).enumerate() {
        if out.len() >= MAX_DECORATIONS * 4 {
            break;
        }
        let content_len = raw_slice.trim_end_matches(['\r', '\n']).len();
        let line_with_nl = if raw_slice.ends_with('\n') {
            raw_slice
        } else {
            tail_buf.clear();
            tail_buf.push_str(raw_slice);
            tail_buf.push('\n');
            tail_buf.as_str()
        };
        parse_single_line(
            &mut parser,
            &mut scopes,
            line_with_nl,
            content_len,
            line_idx as u32,
            set,
            &mut out,
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_tokens<'a>(text: &'a str, quads: &[u32]) -> Vec<(u32, &'a str, u32)> {
        let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let mut res = Vec::new();
        for chunk in quads.chunks_exact(4) {
            let (line_idx, start_u16, end_u16, role) = (chunk[0], chunk[1], chunk[2], chunk[3]);
            let line = lines[line_idx as usize];
            let mut u16_pos = 0u32;
            let mut byte_start = line.len();
            let mut byte_end = line.len();
            for (b_idx, ch) in line.char_indices() {
                if u16_pos == start_u16 {
                    byte_start = b_idx;
                }
                u16_pos += ch.len_utf16() as u32;
                if u16_pos == end_u16 {
                    byte_end = b_idx + ch.len_utf8();
                    break;
                }
            }
            res.push((line_idx, &line[byte_start..byte_end], role));
        }
        res
    }

    #[test]
    fn resolves_all_required_languages_and_rejects_plaintext() {
        for lang in [
            "python", "tsx", "typescript", "javascript", "jsx", "rust", "bash", "sh", "zsh",
            "json", "jsonl", "yaml", "toml", "sql", "go", "c", "cpp", "dockerfile", "makefile",
            "markdown",
        ] {
            assert!(find_syntax(lang).is_some(), "expected syntax for {lang}");
        }
        assert!(find_syntax("plaintext").is_none());
        assert!(find_syntax("").is_none());
    }

    #[test]
    fn python_docstrings_fstrings_decorators_signatures_and_colon_keywords() {
        let py = concat!(
            "@dataclass\n",
            "class User:\n",
            "    \"\"\"Multi-line docstring\n",
            "    with in for and or not inside.\"\"\"\n",
            "    def greet(self, count: int = 1) -> Optional[str]:\n",
            "        try:\n",
            "            msg = f\"hello {user.name}\"\n",
            "            res = client.fetch(url=msg, timeout=5)\n",
            "            return print(len(res)) if True and count is not None else None\n",
            "        except ValueError:\n",
            "            pass\n",
            "        else:\n",
            "            return \"ok\"\n",
        );
        let tokens = decode_tokens(py, &parse(py, "python", 3000));

        // 1. `@dataclass` -> `@` is Property, `dataclass` is Function.
        assert!(tokens.contains(&(0, "@", ROLE_PROPERTY)));
        assert!(tokens.contains(&(0, "dataclass", ROLE_FUNCTION)));

        // 2. `class User:` -> `class` Keyword, `User` Type.
        assert!(tokens.contains(&(1, "class", ROLE_KEYWORD)));
        assert!(tokens.contains(&(1, "User", ROLE_TYPE)));

        // 3. Multi-line `"""..."""` docstring is unified Comment (no leaked keywords inside).
        assert!(tokens.contains(&(2, "\"\"\"Multi-line docstring", ROLE_COMMENT)));
        assert!(tokens.contains(&(3, "    with in for and or not inside.\"\"\"", ROLE_COMMENT)));
        assert!(!tokens.iter().any(|&(line, _, role)| (line == 2 || line == 3) && role == ROLE_KEYWORD));

        // 4. `def greet(self, count: int = 1) -> Optional[str]:`
        assert!(tokens.contains(&(4, "def", ROLE_KEYWORD)));
        assert!(tokens.contains(&(4, "greet", ROLE_FUNCTION)));
        assert!(tokens.contains(&(4, "self", ROLE_CONSTANT)));
        assert!(tokens.contains(&(4, "count", ROLE_PROPERTY)));
        assert!(tokens.contains(&(4, "int", ROLE_TYPE)));
        assert!(tokens.contains(&(4, "=", ROLE_OPERATOR)));
        assert!(tokens.contains(&(4, "1", ROLE_NUMBER)));
        assert!(tokens.contains(&(4, "->", ROLE_OPERATOR)));
        assert!(tokens.contains(&(4, "Optional", ROLE_TYPE)));
        assert!(tokens.contains(&(4, "str", ROLE_TYPE)));

        // 5. `try:` and `else:` are Keywords, NEVER Properties.
        assert!(tokens.contains(&(5, "try", ROLE_KEYWORD)));
        assert!(tokens.contains(&(11, "else", ROLE_KEYWORD)));
        assert!(!tokens.contains(&(5, "try", ROLE_PROPERTY)));
        assert!(!tokens.contains(&(11, "else", ROLE_PROPERTY)));

        // 6. `f"hello {user.name}"` splits string, braces, plain `user`, and `.name` property!
        assert!(tokens.contains(&(6, "f", ROLE_KEYWORD)));
        assert!(tokens.contains(&(6, "\"hello ", ROLE_STRING)));
        assert!(tokens.contains(&(6, "{", ROLE_OPERATOR)));
        assert!(!tokens.iter().any(|&(l, txt, r)| l == 6 && txt.contains("user") && r == ROLE_STRING));
        assert!(tokens.contains(&(6, "name", ROLE_PROPERTY)));
        assert!(tokens.contains(&(6, "}", ROLE_OPERATOR)));
        assert!(tokens.contains(&(6, "\"", ROLE_STRING)));

        // 7. Method calls, keyword args, built-ins, logical operators, and constants.
        assert!(tokens.contains(&(7, "fetch", ROLE_FUNCTION)));
        assert!(tokens.contains(&(7, "url", ROLE_PROPERTY)));
        assert!(tokens.contains(&(7, "timeout", ROLE_PROPERTY)));
        assert!(tokens.contains(&(8, "print", ROLE_FUNCTION)));
        assert!(tokens.contains(&(8, "len", ROLE_FUNCTION)));
        assert!(tokens.contains(&(8, "True", ROLE_CONSTANT)));
        assert!(tokens.contains(&(8, "None", ROLE_CONSTANT)));
        assert!(tokens.contains(&(8, "and", ROLE_KEYWORD)));
        assert!(tokens.contains(&(8, "is", ROLE_KEYWORD)));
        assert!(tokens.contains(&(8, "not", ROLE_KEYWORD)));
    }

    #[test]
    fn utf16_columns_align_accurately_across_cjk_and_surrogate_emoji() {
        // "const label = \"你好😀\"; return 42;\n"
        // "你好" = 2 UTF-16 code units (6 UTF-8 bytes)
        // "😀" = 2 UTF-16 code units (4 UTF-8 bytes)
        let src = "const label = \"你好😀\"; return 42;\n";
        let quads = parse(src, "typescript", 100);
        let decoded = decode_tokens(src, &quads);

        assert!(decoded.contains(&(0, "const", ROLE_KEYWORD)));
        assert!(decoded.contains(&(0, "\"你好😀\"", ROLE_STRING)));
        assert!(decoded.contains(&(0, "return", ROLE_KEYWORD)));
        assert!(decoded.contains(&(0, "42", ROLE_NUMBER)));

        // Verify exact UTF-16 column indices for `return` after CJK + surrogate pair.
        let expected_return_col = "const label = \"你好😀\"; ".encode_utf16().count() as u32;
        assert_eq!(expected_return_col, 22);
        assert!(
            quads
                .chunks_exact(4)
                .any(|q| q == [0, expected_return_col, expected_return_col + 6, ROLE_KEYWORD]),
            "quads={quads:?}"
        );
    }

    #[test]
    fn highlights_bash_tsx_rust_json_yaml_toml_sql_go_and_c() {
        let bash = "if [[ -n \"$FOO\" ]]; then\n  echo \"ok\"\nfi\n";
        let bash_toks = decode_tokens(bash, &parse(bash, "bash", 100));
        assert!(bash_toks.contains(&(0, "if", ROLE_KEYWORD)));
        assert!(bash_toks.contains(&(0, "[[", ROLE_FUNCTION)));
        assert!(bash_toks.contains(&(0, ";", ROLE_OPERATOR)));
        assert!(bash_toks.contains(&(0, "then", ROLE_KEYWORD)));
        assert!(bash_toks.contains(&(0, "$FOO", ROLE_PROPERTY)));
        assert!(bash_toks.contains(&(1, "echo", ROLE_FUNCTION)));
        assert!(bash_toks.contains(&(1, "\"ok\"", ROLE_STRING)));
        assert!(bash_toks.contains(&(2, "fi", ROLE_KEYWORD)));

        let tsx = "export function Card(props: CardProps) {\n  return <View class=\"p-2\">{props.title}</View>;\n}\n";
        let tsx_toks = decode_tokens(tsx, &parse(tsx, "tsx", 100));
        assert!(tsx_toks.contains(&(0, "export", ROLE_KEYWORD)));
        assert!(tsx_toks.contains(&(0, "function", ROLE_KEYWORD)));
        assert!(tsx_toks.contains(&(0, "Card", ROLE_FUNCTION)));
        assert!(tsx_toks.contains(&(0, "props", ROLE_PROPERTY)));
        assert!(tsx_toks.contains(&(0, "CardProps", ROLE_TYPE)));
        assert!(tsx_toks.contains(&(1, "View", ROLE_TYPE)));
        assert!(tsx_toks.contains(&(1, "class", ROLE_PROPERTY)));
        assert!(tsx_toks.contains(&(1, "\"p-2\"", ROLE_STRING)));
        assert!(tsx_toks.contains(&(1, "title", ROLE_PROPERTY)));

        let json = "{\"name\": \"aed\", \"ok\": true, \"n\": 42}\n";
        let json_toks = decode_tokens(json, &parse(json, "json", 100));
        assert!(json_toks.contains(&(0, "\"name\"", ROLE_PROPERTY)));
        assert!(json_toks.contains(&(0, "\"aed\"", ROLE_STRING)));
        assert!(json_toks.contains(&(0, "true", ROLE_CONSTANT)));
        assert!(json_toks.contains(&(0, "42", ROLE_NUMBER)));

        let toml = "[package]\nname = \"aed\"\n";
        let toml_toks = decode_tokens(toml, &parse(toml, "toml", 100));
        assert!(toml_toks.contains(&(0, "package", ROLE_TAG)));
        assert!(toml_toks.contains(&(1, "name", ROLE_PROPERTY)));
        assert!(toml_toks.contains(&(1, "\"aed\"", ROLE_STRING)));

        let yaml = "server:\n  port: 8080\n";
        let yaml_toks = decode_tokens(yaml, &parse(yaml, "yaml", 100));
        assert!(yaml_toks.contains(&(0, "server", ROLE_PROPERTY)));
        assert!(yaml_toks.contains(&(1, "port", ROLE_PROPERTY)));
        assert!(yaml_toks.contains(&(1, "8080", ROLE_NUMBER)));

        let rust = "#[derive(Debug)]\npub struct Config { pub count: usize }\n";
        let rust_toks = decode_tokens(rust, &parse(rust, "rust", 100));
        assert!(rust_toks.contains(&(0, "derive", ROLE_FUNCTION)));
        assert!(rust_toks.contains(&(0, "Debug", ROLE_TYPE)));
        assert!(rust_toks.contains(&(1, "pub", ROLE_KEYWORD)));
        assert!(rust_toks.contains(&(1, "struct", ROLE_KEYWORD)));
        assert!(rust_toks.contains(&(1, "Config", ROLE_TYPE)));
        assert!(rust_toks.contains(&(1, "count", ROLE_PROPERTY)));
        assert!(rust_toks.contains(&(1, "usize", ROLE_TYPE)));

        assert!(!parse("SELECT id FROM users WHERE active = 1;\n", "sql", 100).is_empty());
        assert!(!parse("package main\nfunc main() { return }\n", "go", 100).is_empty());
        assert!(!parse("int main(void) { return 0; }\n", "c", 100).is_empty());
    }
}
