import type { ViewStyle } from "nsh";
import type { EditorDecoration, EditorStyles, EditorToken } from "nsh/base";

export interface SyntaxPalette {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  property: string;
  type: string;
  function: string;
  constant: string;
  operator: string;
  tag: string;
}

export interface ThemeUiColors {
  background: string;
  sidebar: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  accent: string;
  gutter: string;
  activeLine: string;
  selection: string;
  /** The status bar's plane and text; without them it takes `sidebar` and `mutedForeground`. */
  statusBar?: string;
  statusBarForeground?: string;
}

export interface SyntaxClasses {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  property: string;
  type: string;
  function: string;
  constant: string;
  operator: string;
  tag: string;
}

export interface EditorTheme {
  id: string;
  name: string;
  appearance: "dark" | "light";
  ui: ThemeUiColors;
  syntax: SyntaxPalette;
  syntaxClasses: SyntaxClasses;
}

/** A font family's short display name: Nerd Font patch suffixes dropped. */
export function fontDisplayName(family: string): string {
  const name = family.replace(/\s+Nerd Font(?:\s+(?:Mono|Propo))?$/i, "").trim();
  return name || "Mono";
}

export const DEFAULT_THEME_ID = "industrial-paper";

export const EDITOR_THEMES: readonly EditorTheme[] = [
  // DESIGN.md「界面设计语言（Industrial）」: paper, ink, one signal red, stone.
  {
    id: "industrial-paper",
    name: "Industrial Paper",
    appearance: "light",
    ui: {
      background: "#efebe3",
      sidebar: "#e5e0d5",
      card: "#f7f4ee",
      border: "#cfc8bb",
      foreground: "#141414",
      mutedForeground: "#6d685f",
      accent: "#d7381e",
      gutter: "#efebe3",
      activeLine: "#e7e2d8",
      selection: "#d7381e2e",
      statusBar: "#141414",
      statusBarForeground: "#d9d3c7",
    },
    syntax: {
      keyword: "#c62d14",
      string: "#4d5e2e",
      number: "#b45309",
      comment: "#8c8578",
      property: "#2f4b63",
      type: "#141414",
      function: "#141414",
      constant: "#c62d14",
      operator: "#6d685f",
      tag: "#c62d14",
    },
    syntaxClasses: {
      keyword: "text-[#c62d14] font-semibold",
      string: "text-[#4d5e2e]",
      number: "text-[#b45309]",
      comment: "text-[#8c8578] italic",
      property: "text-[#2f4b63]",
      type: "text-[#141414] font-semibold",
      function: "text-[#141414]",
      constant: "text-[#c62d14]",
      operator: "text-[#6d685f]",
      tag: "text-[#c62d14]",
    },
  },
  {
    id: "industrial-carbon",
    name: "Industrial Carbon",
    appearance: "dark",
    ui: {
      background: "#161514",
      sidebar: "#1d1c1a",
      card: "#232220",
      border: "#33312d",
      foreground: "#ede8de",
      mutedForeground: "#8f897e",
      accent: "#e8462b",
      gutter: "#161514",
      activeLine: "#1e1d1b",
      selection: "#e8462b33",
      statusBar: "#0e0e0d",
      statusBarForeground: "#a39c90",
    },
    syntax: {
      keyword: "#f06a4f",
      string: "#b5c28f",
      number: "#e0a96d",
      comment: "#6f6a61",
      property: "#9fb4c7",
      type: "#ede8de",
      function: "#ede8de",
      constant: "#f06a4f",
      operator: "#8f897e",
      tag: "#f06a4f",
    },
    syntaxClasses: {
      keyword: "text-[#f06a4f] font-semibold",
      string: "text-[#b5c28f]",
      number: "text-[#e0a96d]",
      comment: "text-[#6f6a61] italic",
      property: "text-[#9fb4c7]",
      type: "text-[#ede8de] font-semibold",
      function: "text-[#ede8de]",
      constant: "text-[#f06a4f]",
      operator: "text-[#8f897e]",
      tag: "text-[#f06a4f]",
    },
  },
  {
    id: "kanagawa-dragon",
    name: "Kanagawa Dragon",
    appearance: "dark",
    ui: {
      background: "#181616",
      sidebar: "#121111",
      card: "#201d1d",
      border: "#2d2a2a",
      foreground: "#c5c9c5",
      mutedForeground: "#737c73",
      accent: "#8ba4b0",
      gutter: "#151313",
      activeLine: "#221f1f",
      selection: "#2d4f6780",
    },
    syntax: {
      keyword: "#c4746e",
      string: "#8a9a7b",
      number: "#a292a3",
      comment: "#737c73",
      property: "#7aa89f",
      type: "#e6c384",
      function: "#8ba4b0",
      constant: "#b6927b",
      operator: "#c4b28a",
      tag: "#e46876",
    },
    syntaxClasses: {
      keyword: "text-rose-400",
      string: "text-emerald-300",
      number: "text-fuchsia-300",
      comment: "text-stone-500 italic",
      property: "text-teal-300",
      type: "text-amber-200",
      function: "text-sky-300",
      constant: "text-orange-300 font-semibold",
      operator: "text-amber-300",
      tag: "text-rose-400",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    appearance: "dark",
    ui: {
      background: "#1a1b26",
      sidebar: "#16161e",
      card: "#24283b",
      border: "#292e42",
      foreground: "#c0caf5",
      mutedForeground: "#565f89",
      accent: "#7aa2f7",
      gutter: "#171822",
      activeLine: "#222436",
      selection: "#33467c88",
    },
    syntax: {
      keyword: "#bb9af7",
      string: "#9ece6a",
      number: "#ff9e64",
      comment: "#565f89",
      property: "#7dcfff",
      type: "#2ac3de",
      function: "#7aa2f7",
      constant: "#ff9e64",
      operator: "#89ddff",
      tag: "#f7768e",
    },
    syntaxClasses: {
      keyword: "text-purple-400",
      string: "text-lime-300",
      number: "text-orange-400",
      comment: "text-slate-500 italic",
      property: "text-cyan-300",
      type: "text-teal-300",
      function: "text-blue-400",
      constant: "text-amber-400 font-semibold",
      operator: "text-sky-300",
      tag: "text-rose-400",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    ui: {
      background: "#1e1e2e",
      sidebar: "#181825",
      card: "#262639",
      border: "#313244",
      foreground: "#cdd6f4",
      mutedForeground: "#6c7086",
      accent: "#cba6f7",
      gutter: "#1a1a29",
      activeLine: "#27273a",
      selection: "#45475a88",
    },
    syntax: {
      keyword: "#cba6f7",
      string: "#a6e3a1",
      number: "#fab387",
      comment: "#6c7086",
      property: "#89dceb",
      type: "#f9e2af",
      function: "#89b4fa",
      constant: "#f5c2e7",
      operator: "#94e2d5",
      tag: "#f38ba8",
    },
    syntaxClasses: {
      keyword: "text-violet-300",
      string: "text-green-300",
      number: "text-orange-300",
      comment: "text-zinc-500 italic",
      property: "text-sky-300",
      type: "text-yellow-200",
      function: "text-blue-300",
      constant: "text-pink-300 font-semibold",
      operator: "text-teal-300",
      tag: "text-pink-400",
    },
  },
  {
    id: "one-dark",
    name: "One Dark Pro",
    appearance: "dark",
    ui: {
      background: "#282c34",
      sidebar: "#21252b",
      card: "#2c313a",
      border: "#343942",
      foreground: "#abb2bf",
      mutedForeground: "#5c6370",
      accent: "#61afef",
      gutter: "#242830",
      activeLine: "#2c313c",
      selection: "#3e445199",
    },
    syntax: {
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      comment: "#5c6370",
      property: "#e06c75",
      type: "#e5c07b",
      function: "#61afef",
      constant: "#d19a66",
      operator: "#56b6c2",
      tag: "#e06c75",
    },
    syntaxClasses: {
      keyword: "text-fuchsia-400",
      string: "text-emerald-400",
      number: "text-amber-400",
      comment: "text-slate-500 italic",
      property: "text-red-400",
      type: "text-yellow-300",
      function: "text-sky-400",
      constant: "text-amber-400 font-semibold",
      operator: "text-cyan-400",
      tag: "text-red-400",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    appearance: "dark",
    ui: {
      background: "#191724",
      sidebar: "#1f1d2e",
      card: "#26233a",
      border: "#2e2b44",
      foreground: "#e0def4",
      mutedForeground: "#6e6a86",
      accent: "#c4a7e7",
      gutter: "#171521",
      activeLine: "#232034",
      selection: "#403d5288",
    },
    syntax: {
      keyword: "#31748f",
      string: "#f6c177",
      number: "#ebbcba",
      comment: "#6e6a86",
      property: "#9ccfd8",
      type: "#f6c177",
      function: "#c4a7e7",
      constant: "#ebbcba",
      operator: "#908caa",
      tag: "#eb6f92",
    },
    syntaxClasses: {
      keyword: "text-cyan-400",
      string: "text-amber-300",
      number: "text-rose-300",
      comment: "text-slate-500 italic",
      property: "text-teal-200",
      type: "text-amber-200",
      function: "text-purple-300",
      constant: "text-rose-300 font-semibold",
      operator: "text-indigo-300",
      tag: "text-rose-400",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    appearance: "light",
    ui: {
      background: "#ffffff",
      sidebar: "#f6f8fa",
      card: "#f0f3f6",
      border: "#d0d7de",
      foreground: "#1f2328",
      mutedForeground: "#656d76",
      accent: "#0969da",
      gutter: "#f6f8fa",
      activeLine: "#f0f4f8",
      selection: "#0969da28",
    },
    syntax: {
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#6e7781",
      property: "#116329",
      type: "#953800",
      function: "#8250df",
      constant: "#0550ae",
      operator: "#cf222e",
      tag: "#116329",
    },
    syntaxClasses: {
      keyword: "text-red-600",
      string: "text-blue-900",
      number: "text-blue-600",
      comment: "text-slate-500 italic",
      property: "text-emerald-700",
      type: "text-amber-700",
      function: "text-purple-700",
      constant: "text-blue-700 font-semibold",
      operator: "text-red-600",
      tag: "text-emerald-700",
    },
  },
];

export function getThemeById(id?: string | null): EditorTheme {
  if (!id) return EDITOR_THEMES[0];
  const normalized = id.trim().toLowerCase();
  const exact = EDITOR_THEMES.find((t) => t.id === normalized);
  if (exact) return exact;
  const byName = EDITOR_THEMES.find(
    (t) => t.name.toLowerCase() === normalized || normalized.includes(t.id.split("-")[0])
  );
  return byName ?? EDITOR_THEMES[0];
}

export function buildEditorThemeStyles(theme: EditorTheme): EditorStyles {
  return {
    gutter: {
      backgroundColor: theme.ui.gutter,
    },
    lineNumber: {
      color: theme.ui.mutedForeground,
    },
    activeLineNumber: {
      color: theme.ui.foreground,
      fontWeight: "bold",
    },
    content: {
      backgroundColor: theme.ui.background,
    },
    activeLine: {
      backgroundColor: theme.ui.activeLine,
    },
    selection: {
      backgroundColor: theme.ui.selection,
    },
    caret: {
      backgroundColor: theme.ui.accent,
    },
    indentGuide: {
      backgroundColor: theme.ui.border,
    },
  };
}

const CODE_KEYWORDS = new Set([
  "import", "export", "from", "default", "as", "const", "let", "var",
  "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "try", "catch", "finally", "throw",
  "new", "typeof", "instanceof", "in", "of", "void", "delete",
  "async", "await", "yield", "class", "extends", "implements",
  "interface", "type", "enum", "namespace", "module", "declare",
  "public", "private", "protected", "readonly", "static", "abstract",
  "fn", "pub", "mod", "use", "crate", "super", "struct", "impl",
  "trait", "where", "match", "mut", "ref", "move", "unsafe", "extern",
  "def", "elif", "except", "lambda", "pass", "raise", "with", "global",
  "nonlocal", "assert", "del", "package", "func", "chan", "defer",
  "go", "select", "fallthrough", "range", "map", "local", "then",
  "end", "elseif", "repeat", "until", "select", "from", "where",
  "insert", "into", "values", "update", "set", "join", "left",
  "right", "inner", "outer", "on", "group", "by", "order", "limit",
  "create", "table", "drop", "alter", "index", "view", "and", "or", "not",
]);

const CODE_CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity",
  "True", "False", "None", "self", "this", "super", "nil", "iota",
]);

const CODE_TYPES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "object",
  "symbol", "bigint", "int", "float", "double", "char", "bool",
  "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
  "f32", "f64", "str", "String", "Vec", "Option", "Result", "Box", "Arc", "Rc",
  "Promise", "Record", "Array", "Map", "Set", "Readonly", "Partial",
  "Signal", "Accessor", "JSX", "Element",
]);

const MAX_DECORATED_LINES = 600;
const MAX_DECORATIONS = 4000;

function makeDeco(
  line: number,
  startCol: number,
  endCol: number,
  colorOrClass: string,
  token: EditorToken,
  extra?: { italic?: boolean; bold?: boolean }
): EditorDecoration {
  const deco: EditorDecoration = {
    range: {
      start: { line, column: startCol },
      end: { line, column: endCol },
    },
    token,
  };
  if (colorOrClass.startsWith("text-")) {
    const classParts = [colorOrClass];
    if (extra?.italic && !colorOrClass.includes("italic")) classParts.push("italic");
    if (extra?.bold && !colorOrClass.includes("font-")) classParts.push("font-semibold");
    deco.class = classParts.join(" ");
  }
  return deco;
}

function pushRegexMatches(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  regex: RegExp,
  color: string,
  token: EditorToken,
  extra?: { italic?: boolean; bold?: boolean; group?: number }
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(lineText);
  while (match !== null && out.length < MAX_DECORATIONS) {
    const grp = extra?.group ?? 0;
    const text = match[grp];
    if (text && text.length > 0) {
      const offsetInMatch = grp > 0 ? match[0].indexOf(text) : 0;
      const start = match.index + Math.max(0, offsetInMatch);
      out.push(makeDeco(lineIdx, start, start + text.length, color, token, extra));
    }
    if (match[0].length === 0) regex.lastIndex += 1;
    match = regex.exec(lineText);
  }
}

function decorateJsonLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  const strRegex = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
  const maskedLine = lineText.replace(
    strRegex,
    (full, quoted: string, colon: string | undefined, offset: number) => {
      if (out.length < MAX_DECORATIONS) {
        const isKey = Boolean(colon);
        out.push(
          makeDeco(
            lineIdx,
            offset,
            offset + quoted.length,
            isKey ? palette.property : palette.string,
            isKey ? "built" : "string"
          )
        );
      }
      return " ".repeat(full.length);
    }
  );
  pushRegexMatches(
    out,
    lineIdx,
    maskedLine,
    /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    palette.number,
    "number"
  );
  pushRegexMatches(
    out,
    lineIdx,
    maskedLine,
    /\b(?:true|false|null)\b/g,
    palette.constant,
    "built",
    { bold: true }
  );
}

function decorateConfigLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  const trimmed = lineText.trimStart();
  const indent = lineText.length - trimmed.length;
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
    out.push(makeDeco(lineIdx, indent, lineText.length, palette.comment, "comment", { italic: true }));
    return;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    out.push(makeDeco(lineIdx, indent, lineText.length, palette.tag, "title", { bold: true }));
    return;
  }
  pushRegexMatches(out, lineIdx, lineText, /^(\s*[\w.-]+)\s*[:=]/g, palette.property, "attr", {
    group: 1,
  });
  pushRegexMatches(out, lineIdx, lineText, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, palette.string, "string");
  pushRegexMatches(out, lineIdx, lineText, /\b-?\d+(?:\.\d+)?\b/g, palette.number, "number");
  pushRegexMatches(out, lineIdx, lineText, /\b(?:true|false|null|yes|no|on|off)\b/gi, palette.constant, "built");
}

function decorateMarkdownLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  if (/^\s*#{1,6}\s/.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.keyword, "title", { bold: true }));
    return;
  }
  if (/^\s*```/.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.property, "keyword"));
    return;
  }
  pushRegexMatches(out, lineIdx, lineText, /`[^`]+`/g, palette.string, "string");
  pushRegexMatches(out, lineIdx, lineText, /\[([^\]]+)\]\(([^)]+)\)/g, palette.function, "attr");
  pushRegexMatches(out, lineIdx, lineText, /\*\*[^*]+\*\*/g, palette.type, "title", { bold: true });
}

function decorateSubtitleLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  if (/^\d+\s*$/.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.number, "number", { bold: true }));
    return;
  }
  if (lineText.includes("-->")) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.property, "attr"));
  }
}

function classifyCodeIdentifier(
  word: string,
  lineText: string,
  endCol: number,
  palette: SyntaxPalette
): { color: string; token: EditorToken; bold?: boolean } | null {
  const after = lineText.slice(endCol).trimStart();
  if (after[0] === ":" && after[1] !== ":") {
    return { color: palette.property, token: "attr" };
  }
  if (CODE_KEYWORDS.has(word)) {
    return { color: palette.keyword, token: "keyword" };
  }
  if (CODE_CONSTANTS.has(word)) {
    return { color: palette.constant, token: "built" };
  }
  if (CODE_TYPES.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
    return { color: palette.type, token: "built" };
  }
  if (lineText[endCol] === "(") {
    return { color: palette.function, token: "title" };
  }
  return null;
}

const HASH_COMMENT_LANGS = new Set([
  "python",
  "bash",
  "ruby",
  "dockerfile",
  "makefile",
  "perl",
  "r",
]);

function extractStringsAndComments(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  language: string,
  palette: SyntaxPalette
): string {
  const tokenRegex = HASH_COMMENT_LANGS.has(language)
    ? /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*|#.*)/g
    : /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*)/g;

  return lineText.replace(
    tokenRegex,
    (full, strToken: string | undefined, commentToken: string | undefined, offset: number) => {
      if (out.length < MAX_DECORATIONS) {
        if (strToken) {
          out.push(makeDeco(lineIdx, offset, offset + full.length, palette.string, "string"));
        } else if (commentToken) {
          out.push(
            makeDeco(lineIdx, offset, offset + full.length, palette.comment, "comment", {
              italic: true,
            })
          );
        }
      }
      return " ".repeat(full.length);
    }
  );
}

function decorateCodeLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  language: string,
  palette: SyntaxPalette
): void {
  const maskedCode = extractStringsAndComments(out, lineIdx, lineText, language, palette);

  // JSX / HTML / XML tags
  pushRegexMatches(
    out,
    lineIdx,
    maskedCode,
    /<\/?[A-Za-z][A-Za-z0-9._-]*/g,
    palette.tag,
    "keyword"
  );

  // Numbers
  pushRegexMatches(
    out,
    lineIdx,
    maskedCode,
    /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi,
    palette.number,
    "number"
  );

  // Identifiers (properties, keywords, types, constants, functions)
  const wordRegex = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  let match: RegExpExecArray | null = wordRegex.exec(maskedCode);
  while (match !== null && out.length < MAX_DECORATIONS) {
    const word = match[0];
    const endCol = match.index + word.length;
    const hit = classifyCodeIdentifier(word, maskedCode, endCol, palette);
    if (hit) {
      out.push(makeDeco(lineIdx, match.index, endCol, hit.color, hit.token, { bold: hit.bold }));
    }
    match = wordRegex.exec(maskedCode);
  }
}

type LineDecorator = (
  out: EditorDecoration[],
  lineIdx: number,
  line: string,
  palette: SyntaxPalette
) => void;

const SPECIAL_LINE_DECORATORS: Record<string, LineDecorator> = {
  json: decorateJsonLine,
  jsonl: decorateJsonLine,
  yaml: decorateConfigLine,
  toml: decorateConfigLine,
  ini: decorateConfigLine,
  dotenv: decorateConfigLine,
  gitignore: decorateConfigLine,
  markdown: decorateMarkdownLine,
  srt: decorateSubtitleLine,
  vtt: decorateSubtitleLine,
};

export function computeSyntaxDecorations(
  text: string,
  language: string,
  palette: SyntaxPalette
): EditorDecoration[] {
  if (!text || language === "plaintext") return [];
  const lang = language.toLowerCase();
  const special = SPECIAL_LINE_DECORATORS[lang];
  const lines = text.split(/\r?\n/);
  const limit = Math.min(lines.length, MAX_DECORATED_LINES);
  const out: EditorDecoration[] = [];

  for (let i = 0; i < limit && out.length < MAX_DECORATIONS; i += 1) {
    const line = lines[i];
    if (line && line.length <= 1000) {
      if (special) special(out, i, line, palette);
      else decorateCodeLine(out, i, line, lang, palette);
    }
  }
  return out;
}
