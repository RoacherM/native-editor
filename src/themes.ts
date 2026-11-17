import { highlightCode, setTokens } from "aed/native";
import type { TextStyle } from "nsh";
import type { EditorDecoration, EditorStyles, EditorToken } from "nsh/base";
import { createLruCache } from "./classify";

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
  accentForeground: string;
  gutter: string;
  activeLine: string;
  selection: string;
  /** Distinct status bar plane and text so adjacent `sidebar` surfaces stay separate. */
  statusBar: string;
  statusBarForeground: string;
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

function buildSyntaxClasses(syntax: SyntaxPalette): SyntaxClasses {
  return {
    keyword: `text-[${syntax.keyword}]`,
    string: `text-[${syntax.string}]`,
    number: `text-[${syntax.number}]`,
    comment: `text-[${syntax.comment}] italic`,
    property: `text-[${syntax.property}]`,
    type: `text-[${syntax.type}]`,
    function: `text-[${syntax.function}]`,
    constant: `text-[${syntax.constant}]`,
    operator: `text-[${syntax.operator}]`,
    tag: `text-[${syntax.tag}]`,
  };
}

function defineTheme(
  spec: Omit<EditorTheme, "syntaxClasses">
): EditorTheme {
  return {
    ...spec,
    syntaxClasses: buildSyntaxClasses(spec.syntax),
  };
}

export const DEFAULT_THEME_ID = "industrial-paper";

export const EDITOR_THEMES: readonly EditorTheme[] = [
  // DESIGN.md「界面设计语言（Industrial）」: paper, ink, one signal red, stone.
  defineTheme({
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
      accentForeground: "#ffffff",
      gutter: "#efebe3",
      activeLine: "#e7e2d8",
      selection: "#d7381e2e",
      statusBar: "#141414",
      statusBarForeground: "#d9d3c7",
    },
    syntax: {
      keyword: "#bf3219",
      string: "#3f5e2a",
      number: "#9e4710",
      comment: "#857e72",
      property: "#38586e",
      type: "#24527a",
      function: "#7c4f15",
      constant: "#9e4710",
      operator: "#6d685f",
      tag: "#bf3219",
    },
  }),
  defineTheme({
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
      accentForeground: "#0e0e0d",
      gutter: "#161514",
      activeLine: "#1e1d1b",
      selection: "#e8462b33",
      statusBar: "#0e0e0d",
      statusBarForeground: "#a39c90",
    },
    syntax: {
      keyword: "#e66850",
      string: "#a9be82",
      number: "#e0a96d",
      comment: "#706b62",
      property: "#b8c4cf",
      type: "#8ab4c9",
      function: "#dfbe7d",
      constant: "#d98a6c",
      operator: "#948e82",
      tag: "#e66850",
    },
  }),
  defineTheme({
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
      accentForeground: "#121111",
      gutter: "#151313",
      activeLine: "#221f1f",
      selection: "#2d4f6780",
      statusBar: "#0d0c0c",
      statusBarForeground: "#9e9b93",
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
  }),
  defineTheme({
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
      accentForeground: "#16161e",
      gutter: "#171822",
      activeLine: "#222436",
      selection: "#33467c88",
      statusBar: "#11121a",
      statusBarForeground: "#9aa5ce",
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
  }),
  defineTheme({
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
      accentForeground: "#181825",
      gutter: "#1a1a29",
      activeLine: "#27273a",
      selection: "#45475a88",
      statusBar: "#11111b",
      statusBarForeground: "#a6adc8",
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
  }),
  defineTheme({
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
      accentForeground: "#181a1f",
      gutter: "#242830",
      activeLine: "#2c313c",
      selection: "#3e445199",
      statusBar: "#181a1f",
      statusBarForeground: "#9da5b4",
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
  }),
  defineTheme({
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
      accentForeground: "#191724",
      gutter: "#171521",
      activeLine: "#232034",
      selection: "#403d5288",
      statusBar: "#13111c",
      statusBarForeground: "#9c98b5",
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
  }),
  defineTheme({
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
      accentForeground: "#ffffff",
      gutter: "#f6f8fa",
      activeLine: "#f0f4f8",
      selection: "#0969da28",
      statusBar: "#eaeef2",
      statusBarForeground: "#424a53",
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
  }),
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

/** Maps an `EditorTheme` onto NSH's semantic token names (`nsh.json` `theme.cssVars`). */
export function buildThemeTokens(theme: EditorTheme): Record<string, string> {
  const { ui, appearance } = theme;
  return {
    background: ui.background,
    foreground: ui.foreground,
    card: ui.card,
    "card-foreground": ui.foreground,
    popover: ui.card,
    "popover-foreground": ui.foreground,
    primary: ui.accent,
    "primary-foreground": ui.accentForeground,
    secondary: ui.sidebar,
    "secondary-foreground": ui.foreground,
    muted: ui.sidebar,
    "muted-foreground": ui.mutedForeground,
    accent: ui.activeLine,
    "accent-foreground": ui.foreground,
    destructive: appearance === "light" ? "#d7381e" : "#e8462b",
    border: ui.border,
    input: ui.border,
    ring: ui.accent,
    sidebar: ui.sidebar,
    "sidebar-foreground": ui.mutedForeground,
    "sidebar-primary": ui.accent,
    "sidebar-primary-foreground": ui.accentForeground,
    "sidebar-accent": ui.activeLine,
    "sidebar-accent-foreground": ui.foreground,
    "sidebar-border": ui.border,
    "sidebar-ring": ui.accent,
  };
}

/** Pushes `theme`'s semantic tokens to `aed/native` (`setTokens`); no-ops if no surface is mounted. */
export async function syncThemeTokens(theme: EditorTheme): Promise<void> {
  const colors = buildThemeTokens(theme);
  try {
    await setTokens(colors);
  } catch {
    // Pure unit tests run without a mounted Core surface.
  }
}

function withHexAlpha(hex: string, alphaHex: string): string {
  return `${hex.slice(0, 7)}${alphaHex}`;
}

export function buildEditorThemeStyles(theme: EditorTheme): EditorStyles {
  const quietInk = withHexAlpha(theme.ui.mutedForeground, "99");
  return {
    // nsh-base gutter already offsets its rows by content.paddingTop (rows_top);
    // omitting gutter.paddingTop keeps line number 1 aligned 1:1 with code line 1.
    gutter: {
      backgroundColor: theme.ui.background,
      paddingBottom: 16,
      paddingLeft: 16,
      paddingRight: 14,
    },
    lineNumber: {
      color: quietInk,
      fontVariant: ["tabular-nums"],
    },
    activeLineNumber: {
      color: theme.ui.foreground,
      fontVariant: ["tabular-nums"],
    },
    foldMarker: {
      color: quietInk,
      opacity: 0.72,
    },
    content: {
      backgroundColor: theme.ui.background,
      paddingTop: 12,
      paddingBottom: 24,
      paddingLeft: 6,
      paddingRight: 28,
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
      backgroundColor: withHexAlpha(theme.ui.border, "66"),
    },
    matchingBracket: {
      backgroundColor: withHexAlpha(theme.ui.accent, "24"),
      borderColor: withHexAlpha(theme.ui.accent, "66"),
      borderRadius: 2,
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
  "end", "elseif", "repeat", "until", "insert", "into", "values",
  "update", "set", "join", "left", "right", "inner", "outer", "on",
  "group", "by", "order", "limit", "create", "table", "drop", "alter",
  "index", "view", "and", "or", "not",
]);

const CODE_CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity",
  "True", "False", "None", "self", "cls", "this", "super", "nil", "iota",
]);

const CODE_TYPES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "object",
  "symbol", "bigint", "int", "float", "double", "char", "bool",
  "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
  "f32", "f64", "str", "String", "Vec", "Option", "Result", "Box", "Arc", "Rc",
  "Promise", "Record", "Array", "Map", "Set", "Readonly", "Partial",
  "Signal", "Accessor", "JSX", "Element",
]);

const MAX_DECORATED_LINES = 2400;
const MAX_DECORATIONS = 12000;
const MAX_DECORATION_CACHE_ENTRIES = 48;
const MAX_CACHEABLE_HEAD_LEN = 262_144;
const CLASS_HEX_REGEX = /text-\[(#[0-9a-fA-F]{3,8})\]/;

function normalizeColorClass(colorOrClass: string): string {
  if (colorOrClass.startsWith("text-")) return colorOrClass;
  if (colorOrClass.startsWith("#")) return `text-[${colorOrClass}]`;
  return "";
}

function extractColorHex(colorOrClass: string): string | null {
  if (colorOrClass.startsWith("#")) return colorOrClass;
  return CLASS_HEX_REGEX.exec(colorOrClass)?.[1] ?? null;
}

function buildDecoTextStyle(
  colorHex: string,
  colorOrClass: string,
  extra?: { italic?: boolean; bold?: boolean }
): EditorDecoration["style"] {
  const isItalic = Boolean(extra?.italic) || colorOrClass.includes("italic");
  const isBold =
    Boolean(extra?.bold) ||
    colorOrClass.includes("font-semibold") ||
    colorOrClass.includes("font-bold");
  const style: TextStyle = {
    color: colorHex,
    ...(isItalic ? { fontStyle: "italic" } : {}),
    ...(isBold ? { fontWeight: "600" } : {}),
  };
  return style as EditorDecoration["style"];
}

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
  const baseClass = normalizeColorClass(colorOrClass);
  if (baseClass) {
    const parts = [baseClass];
    if (extra?.italic && !baseClass.includes("italic")) parts.push("italic");
    if (extra?.bold && !baseClass.includes("font-")) parts.push("font-semibold");
    deco.class = parts.join(" ");
  }
  const colorHex = extractColorHex(colorOrClass);
  if (colorHex) {
    deco.style = buildDecoTextStyle(colorHex, colorOrClass, extra);
  }
  return deco;
}

function matchGroupStart(match: RegExpExecArray, grp: number, text: string): number {
  if (grp <= 0) return match.index;
  const offset = match[0].indexOf(text);
  return match.index + (offset > 0 ? offset : 0);
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
  const grp = extra?.group ?? 0;
  let match = regex.exec(lineText);
  while (match !== null && out.length < MAX_DECORATIONS) {
    const text = match[grp];
    if (text) {
      const start = matchGroupStart(match, grp, text);
      out.push(makeDeco(lineIdx, start, start + text.length, color, token, extra));
    }
    if (match[0].length === 0) regex.lastIndex += 1;
    match = regex.exec(lineText);
  }
}

const JSON_STRING_REGEX = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
const JSON_NUMBER_REGEX = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const JSON_CONST_REGEX = /\b(?:true|false|null)\b/g;
const CONFIG_KEY_REGEX = /^(\s*[\w.-]+)\s*[:=]/g;
const CONFIG_STRING_REGEX = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const CONFIG_NUMBER_REGEX = /\b-?\d+(?:\.\d+)?\b/g;
const CONFIG_CONST_REGEX = /\b(?:true|false|null|yes|no|on|off)\b/gi;
const MD_HEADING_REGEX = /^\s*#{1,6}\s/;
const MD_FENCE_REGEX = /^\s*```/;
const MD_INLINE_CODE_REGEX = /`[^`]+`/g;
const MD_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
const MD_BOLD_REGEX = /\*\*[^*]+\*\*/g;
const SUBTITLE_INDEX_REGEX = /^\d+\s*$/;
const CODE_PASCAL_REGEX = /^[A-Z][A-Za-z0-9_]*$/;
const CODE_TOKEN_HASH_REGEX = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*|#.*)/g;
const CODE_TOKEN_SLASH_REGEX = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*)/g;
const CODE_TAG_REGEX = /<\/?[A-Za-z][A-Za-z0-9._-]*/g;
const CODE_NUMBER_REGEX = /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi;
const CODE_WORD_REGEX = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;

function decorateJsonLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  JSON_STRING_REGEX.lastIndex = 0;
  const maskedLine = lineText.replace(
    JSON_STRING_REGEX,
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
  pushRegexMatches(out, lineIdx, maskedLine, JSON_NUMBER_REGEX, palette.number, "number");
  pushRegexMatches(out, lineIdx, maskedLine, JSON_CONST_REGEX, palette.constant, "built");
}

function nextNonSpaceIndex(lineText: string, from: number): number {
  let idx = from;
  while (idx < lineText.length && lineText.charCodeAt(idx) <= 32) {
    idx += 1;
  }
  return idx;
}

function decorateConfigLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  const indent = nextNonSpaceIndex(lineText, 0);
  const first = lineText.charCodeAt(indent);
  if (first === 35 || first === 59) {
    out.push(makeDeco(lineIdx, indent, lineText.length, palette.comment, "comment", { italic: true }));
    return;
  }
  const end = lineText.trimEnd();
  if (first === 91 && end.endsWith("]")) {
    out.push(makeDeco(lineIdx, indent, lineText.length, palette.tag, "title"));
    return;
  }
  pushRegexMatches(out, lineIdx, lineText, CONFIG_KEY_REGEX, palette.property, "attr", {
    group: 1,
  });
  pushRegexMatches(out, lineIdx, lineText, CONFIG_STRING_REGEX, palette.string, "string");
  pushRegexMatches(out, lineIdx, lineText, CONFIG_NUMBER_REGEX, palette.number, "number");
  pushRegexMatches(out, lineIdx, lineText, CONFIG_CONST_REGEX, palette.constant, "built");
}

function decorateMarkdownLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  if (MD_HEADING_REGEX.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.keyword, "title", { bold: true }));
    return;
  }
  if (MD_FENCE_REGEX.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.property, "keyword"));
    return;
  }
  pushRegexMatches(out, lineIdx, lineText, MD_INLINE_CODE_REGEX, palette.string, "string");
  pushRegexMatches(out, lineIdx, lineText, MD_LINK_REGEX, palette.function, "attr");
  pushRegexMatches(out, lineIdx, lineText, MD_BOLD_REGEX, palette.type, "title", { bold: true });
}

function decorateSubtitleLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  palette: SyntaxPalette
): void {
  if (SUBTITLE_INDEX_REGEX.test(lineText)) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.number, "number"));
    return;
  }
  if (lineText.includes("-->")) {
    out.push(makeDeco(lineIdx, 0, lineText.length, palette.property, "attr"));
  }
}

const COLON_PROP_LANGS = new Set([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "rust",
  "go",
  "swift",
  "graphql",
  "hcl",
]);

const TRIPLE_QUOTE_LANGS = new Set([
  "python",
  "py",
  "toml",
  "graphql",
  "kotlin",
  "swift",
  "julia",
  "elixir",
]);

const CODE_DECORATOR_REGEX = /@[A-Za-z_][A-Za-z0-9_.]*/g;

function isPropertyColon(lineText: string, endCol: number): boolean {
  const afterIdx = nextNonSpaceIndex(lineText, endCol);
  return lineText.charCodeAt(afterIdx) === 58 && lineText.charCodeAt(afterIdx + 1) !== 58;
}

function classifyCodeIdentifier(
  word: string,
  lineText: string,
  endCol: number,
  allowColonProp: boolean,
  palette: SyntaxPalette
): { color: string; token: EditorToken } | null {
  if (CODE_KEYWORDS.has(word)) {
    return { color: palette.keyword, token: "keyword" };
  }
  if (CODE_CONSTANTS.has(word)) {
    return { color: palette.constant, token: "built" };
  }
  if (CODE_TYPES.has(word) || CODE_PASCAL_REGEX.test(word)) {
    return { color: palette.type, token: "built" };
  }
  if (lineText.charCodeAt(endCol) === 40) {
    return { color: palette.function, token: "title" };
  }
  if (allowColonProp && isPropertyColon(lineText, endCol)) {
    return { color: palette.property, token: "attr" };
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

interface TripleQuoteState {
  delim: '"""' | "'''" | null;
}

function emitTripleSpan(
  out: EditorDecoration[],
  lineIdx: number,
  start: number,
  end: number,
  isPython: boolean,
  palette: SyntaxPalette
): void {
  if (out.length >= MAX_DECORATIONS || start >= end) return;
  if (isPython) {
    out.push(makeDeco(lineIdx, start, end, palette.comment, "comment", { italic: true }));
  } else {
    out.push(makeDeco(lineIdx, start, end, palette.string, "string"));
  }
}

function pickEarlierQuote(
  doubleIdx: number,
  singleIdx: number
): { idx: number; delim: '"""' | "'''" } | null {
  if (doubleIdx >= 0 && (singleIdx < 0 || doubleIdx < singleIdx)) {
    return { idx: doubleIdx, delim: '"""' };
  }
  return singleIdx >= 0 ? { idx: singleIdx, delim: "'''" } : null;
}

function rewindStringPrefix(lineText: string, quoteIdx: number): number {
  let start = quoteIdx;
  while (start > 0 && quoteIdx - start < 2 && "rRfFbBuU".includes(lineText[start - 1])) {
    start -= 1;
  }
  return start > 0 && /\w/.test(lineText[start - 1]) ? quoteIdx : start;
}

function maskSpan(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function maskTripleQuotes(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  isPython: boolean,
  palette: SyntaxPalette,
  state: TripleQuoteState
): string {
  let masked = lineText;
  let cursor = 0;
  if (state.delim !== null) {
    const close = masked.indexOf(state.delim, 0);
    if (close < 0) {
      emitTripleSpan(out, lineIdx, 0, masked.length, isPython, palette);
      return " ".repeat(masked.length);
    }
    const end = close + 3;
    emitTripleSpan(out, lineIdx, 0, end, isPython, palette);
    masked = maskSpan(masked, 0, end);
    state.delim = null;
    cursor = end;
  }
  if (masked.charCodeAt(nextNonSpaceIndex(masked, cursor)) === 35) return masked;
  let hit = pickEarlierQuote(masked.indexOf('"""', cursor), masked.indexOf("'''", cursor));
  while (hit !== null && out.length < MAX_DECORATIONS) {
    const start = rewindStringPrefix(masked, hit.idx);
    const close = masked.indexOf(hit.delim, hit.idx + 3);
    if (close < 0) {
      emitTripleSpan(out, lineIdx, start, masked.length, isPython, palette);
      state.delim = hit.delim;
      return maskSpan(masked, start, masked.length);
    }
    const end = close + 3;
    emitTripleSpan(out, lineIdx, start, end, isPython, palette);
    masked = maskSpan(masked, start, end);
    cursor = end;
    hit = pickEarlierQuote(masked.indexOf('"""', cursor), masked.indexOf("'''", cursor));
  }
  return masked;
}

function extractStringsAndComments(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  language: string,
  palette: SyntaxPalette
): string {
  const tokenRegex = HASH_COMMENT_LANGS.has(language)
    ? CODE_TOKEN_HASH_REGEX
    : CODE_TOKEN_SLASH_REGEX;
  tokenRegex.lastIndex = 0;

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

function extractDecorators(
  out: EditorDecoration[],
  lineIdx: number,
  maskedCode: string,
  palette: SyntaxPalette
): string {
  if (!maskedCode.includes("@")) return maskedCode;
  CODE_DECORATOR_REGEX.lastIndex = 0;
  return maskedCode.replace(CODE_DECORATOR_REGEX, (full, offset: number) => {
    if (out.length < MAX_DECORATIONS) {
      out.push(makeDeco(lineIdx, offset, offset + full.length, palette.function, "title"));
    }
    return " ".repeat(full.length);
  });
}

function decorateCodeLine(
  out: EditorDecoration[],
  lineIdx: number,
  lineText: string,
  language: string,
  palette: SyntaxPalette,
  tripleState?: TripleQuoteState
): void {
  const afterTriple =
    tripleState && TRIPLE_QUOTE_LANGS.has(language)
      ? maskTripleQuotes(
          out,
          lineIdx,
          lineText,
          language === "python" || language === "py",
          palette,
          tripleState
        )
      : lineText;
  const afterStrings = extractStringsAndComments(out, lineIdx, afterTriple, language, palette);
  const maskedCode = extractDecorators(out, lineIdx, afterStrings, palette);
  pushRegexMatches(out, lineIdx, maskedCode, CODE_TAG_REGEX, palette.tag, "keyword");
  pushRegexMatches(out, lineIdx, maskedCode, CODE_NUMBER_REGEX, palette.number, "number");

  const allowColonProp = COLON_PROP_LANGS.has(language);
  CODE_WORD_REGEX.lastIndex = 0;
  let match = CODE_WORD_REGEX.exec(maskedCode);
  while (match !== null && out.length < MAX_DECORATIONS) {
    const word = match[0];
    const endCol = match.index + word.length;
    const hit = classifyCodeIdentifier(word, maskedCode, endCol, allowColonProp, palette);
    if (hit) {
      out.push(makeDeco(lineIdx, match.index, endCol, hit.color, hit.token));
    }
    match = CODE_WORD_REGEX.exec(maskedCode);
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

interface CachedSyntaxEntry {
  headSlice: string;
  decos: EditorDecoration[];
}

const SYNTAX_DECORATION_CACHE = createLruCache<string, CachedSyntaxEntry>(
  MAX_DECORATION_CACHE_ENTRIES
);

function sliceHeadLines(text: string, maxLines: number): string {
  let pos = 0;
  for (let i = 0; i < maxLines; i += 1) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) return text;
    pos = nl + 1;
  }
  return text.slice(0, pos - 1);
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function decorateBoundedLines(
  headText: string,
  lang: string,
  palette: SyntaxPalette
): EditorDecoration[] {
  const tripleState: TripleQuoteState = { delim: null };
  const decorateLine: LineDecorator =
    SPECIAL_LINE_DECORATORS[lang] ??
    ((acc, idx, line, pal) => decorateCodeLine(acc, idx, line, lang, pal, tripleState));
  const out: EditorDecoration[] = [];
  let pos = 0;
  let lineIdx = 0;

  while (lineIdx < MAX_DECORATED_LINES && out.length < MAX_DECORATIONS) {
    const nl = headText.indexOf("\n", pos);
    const end = nl < 0 ? headText.length : nl;
    const rawLine = stripTrailingCr(headText.slice(pos, end));
    if (rawLine.length > 0 && rawLine.length <= 1000) {
      decorateLine(out, lineIdx, rawLine, palette);
    }
    if (nl < 0) break;
    pos = nl + 1;
    lineIdx += 1;
  }
  return out;
}

function resolveSyntaxPalette(
  syntaxClassesOrTheme: SyntaxPalette | EditorTheme
): SyntaxPalette {
  return "syntaxClasses" in syntaxClassesOrTheme
    ? syntaxClassesOrTheme.syntaxClasses
    : syntaxClassesOrTheme;
}

function buildSyntaxSlotKey(
  headSlice: string,
  lang: string,
  palette: SyntaxPalette,
  cacheKey?: string
): string | null {
  if (headSlice.length > MAX_CACHEABLE_HEAD_LEN) return null;
  if (cacheKey) {
    return `k:${cacheKey}\0${lang}\0${palette.keyword}\0${palette.string}`;
  }
  return `u:${lang}\0${palette.keyword}\0${palette.string}\0${headSlice}`;
}

export function computeSyntaxDecorations(
  text: string,
  language: string,
  syntaxClassesOrTheme: SyntaxPalette | EditorTheme,
  cacheKey?: string
): EditorDecoration[] {
  if (!text || language === "plaintext") return [];
  const lang = language.toLowerCase();
  const palette = resolveSyntaxPalette(syntaxClassesOrTheme);
  const headSlice = sliceHeadLines(text, MAX_DECORATED_LINES);
  const slotKey = buildSyntaxSlotKey(headSlice, lang, palette, cacheKey);

  if (slotKey) {
    const cached = SYNTAX_DECORATION_CACHE.get(slotKey);
    if (cached && cached.headSlice === headSlice) return cached.decos;
  }

  const decos = decorateBoundedLines(headSlice, lang, palette);
  if (slotKey) {
    SYNTAX_DECORATION_CACHE.set(slotKey, { headSlice, decos });
  }
  return decos;
}

const MAX_NATIVE_LINES = 3000;
const FALLBACK_ONLY_LANGS = new Set(["srt", "vtt", "mermaid"]);

interface RoleSpec {
  key: keyof SyntaxPalette;
  token: EditorToken;
  italic?: boolean;
}

const NATIVE_ROLE_SPECS: readonly (RoleSpec | null)[] = [
  null,
  { key: "comment", token: "comment", italic: true },
  { key: "keyword", token: "keyword" },
  { key: "string", token: "string" },
  { key: "number", token: "number" },
  { key: "function", token: "title" },
  { key: "type", token: "built" },
  { key: "constant", token: "built" },
  { key: "property", token: "attr" },
  { key: "operator", token: "keyword" },
  { key: "tag", token: "keyword" },
];

type RoleTemplate = Pick<EditorDecoration, "token" | "class" | "style">;

function buildRoleTemplates(palette: SyntaxPalette): (RoleTemplate | null)[] {
  return NATIVE_ROLE_SPECS.map((spec) => {
    if (!spec) return null;
    const sample = makeDeco(0, 0, 1, palette[spec.key], spec.token, { italic: spec.italic });
    return { token: sample.token, class: sample.class, style: sample.style };
  });
}

/** Convert flat `[line, startCol, endCol, role]` UTF-16 quads from `aed/native` into `EditorDecoration`s. */
export function decodeNativeSyntaxQuads(
  quads: readonly number[],
  syntaxClassesOrTheme: SyntaxPalette | EditorTheme
): EditorDecoration[] {
  if (quads.length < 4) return [];
  const templates = buildRoleTemplates(resolveSyntaxPalette(syntaxClassesOrTheme));
  const out: EditorDecoration[] = [];
  const limit = Math.min(quads.length - (quads.length % 4), MAX_DECORATIONS * 4);
  for (let i = 0; i < limit; i += 4) {
    const tpl = templates[quads[i + 3]];
    if (tpl) {
      out.push({
        range: {
          start: { line: quads[i], column: quads[i + 1] },
          end: { line: quads[i], column: quads[i + 2] },
        },
        token: tpl.token,
        ...(tpl.class ? { class: tpl.class } : {}),
        ...(tpl.style ? { style: tpl.style } : {}),
      });
    }
  }
  return out;
}

interface CachedNativeQuads {
  headSlice: string;
  quads: number[];
}

const NATIVE_QUADS_CACHE = createLruCache<string, CachedNativeQuads>(
  MAX_DECORATION_CACHE_ENTRIES
);

function buildNativeQuadKey(headSlice: string, lang: string, cacheKey?: string): string | null {
  if (headSlice.length > MAX_CACHEABLE_HEAD_LEN) return null;
  if (cacheKey) return `nq:${cacheKey.split("\0")[0]}\0${lang}`;
  return `nu:${lang}\0${headSlice}`;
}

async function fetchNativeQuads(
  headSlice: string,
  lang: string,
  quadKey: string | null
): Promise<number[]> {
  if (quadKey) {
    const cached = NATIVE_QUADS_CACHE.get(quadKey);
    if (cached && cached.headSlice === headSlice) return cached.quads;
  }
  const quads = await highlightCode(headSlice, lang, MAX_NATIVE_LINES);
  if (quadKey) NATIVE_QUADS_CACHE.set(quadKey, { headSlice, quads });
  return quads;
}

/**
 * Highlights up to 3,000 lines asynchronously via `aed/native` TextMate (`syntect` + `two-face`)
 * on a blocking worker thread, falling back to `computeSyntaxDecorations` without a mounted Core.
 */
export async function highlightSyntaxAsync(
  text: string,
  language: string,
  syntaxClassesOrTheme: SyntaxPalette | EditorTheme,
  cacheKey?: string
): Promise<EditorDecoration[]> {
  if (!text || language === "plaintext") return [];
  const lang = language.toLowerCase();
  if (FALLBACK_ONLY_LANGS.has(lang)) {
    return computeSyntaxDecorations(text, lang, syntaxClassesOrTheme, cacheKey);
  }
  const headSlice = sliceHeadLines(text, MAX_NATIVE_LINES);
  const quadKey = buildNativeQuadKey(headSlice, lang, cacheKey);
  try {
    const quads = await fetchNativeQuads(headSlice, lang, quadKey);
    return decodeNativeSyntaxQuads(quads, syntaxClassesOrTheme);
  } catch {
    return computeSyntaxDecorations(text, lang, syntaxClassesOrTheme, cacheKey);
  }
}
