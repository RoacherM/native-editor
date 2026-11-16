import type { DataTableColumn } from "nsh/base";
import * as fs from "fs/promises";
import * as path from "path";
import process from "process";

// DESIGN.md「文件预览与 Mermaid 渲染契约」
export type FileKind =
  | "code"
  | "markdown"
  | "mermaid"
  | "html"
  | "table"
  | "diff"
  | "image"
  | "video"
  | "audio"
  | "quicklook"
  | "binary";

export type PreviewMode = "preview" | "source" | "diff";

export type ViewerIoStrategy = "text" | "bytes" | "stat";

export interface ViewerModeContext {
  mimeType: string;
  editable: boolean;
  hasDiff: boolean;
  currentMode?: PreviewMode;
}

export interface ViewerSpec {
  io: ViewerIoStrategy;
  editable: boolean;
  canPrewarm: boolean;
  hasRichPreview: boolean;
  rawModeLabel: "Markdown" | "Code";
  defaultMode: PreviewMode;
  badge: string;
  modes(ctx: ViewerModeContext): PreviewMode[];
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface TableData {
  columns: DataTableColumn[];
  rows: (string | number)[][];
  /** 1-based numbers of the JSONL lines left out because they are not JSON objects. */
  invalidLines: number[];
}

export interface FileClassification {
  kind: FileKind;
  language: string;
  defaultMode: PreviewMode;
  mimeType: string;
}

export interface LruCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
}

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) return undefined;
  const val = map.get(key)!;
  map.delete(key);
  map.set(key, val);
  return val;
}

function lruTrim<K, V>(
  map: Map<K, V>,
  max: number,
  onEvict?: (key: K, value: V) => void,
): void {
  while (map.size > max) {
    const oldest = map.entries().next();
    if (oldest.done) break;
    const [oldKey, oldVal] = oldest.value;
    map.delete(oldKey);
    onEvict?.(oldKey, oldVal);
  }
}

function lruSet<K, V>(
  map: Map<K, V>,
  max: number,
  key: K,
  value: V,
  onEvict?: (key: K, value: V) => void,
): void {
  if (max <= 0) {
    if (map.has(key)) lruDelete(map, key, onEvict);
    onEvict?.(key, value);
    return;
  }
  if (map.has(key)) {
    const prev = map.get(key)!;
    map.delete(key);
    map.set(key, value);
    if (!Object.is(prev, value)) onEvict?.(key, prev);
    return;
  }
  map.set(key, value);
  lruTrim(map, max, onEvict);
}

function lruDelete<K, V>(
  map: Map<K, V>,
  key: K,
  onEvict?: (key: K, value: V) => void,
): boolean {
  if (!map.has(key)) return false;
  const val = map.get(key)!;
  map.delete(key);
  onEvict?.(key, val);
  return true;
}

function lruClear<K, V>(
  map: Map<K, V>,
  onEvict?: (key: K, value: V) => void,
): void {
  const entries = onEvict ? [...map.entries()] : [];
  map.clear();
  for (const [k, v] of entries) onEvict!(k, v);
}

/** Minimal Map-backed bounded LRU cache with deterministic eviction disposal. */
export function createLruCache<K, V>(
  max: number,
  onEvict?: (key: K, value: V) => void,
): LruCache<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => lruGet(map, key),
    set: (key, value) => lruSet(map, max, key, value, onEvict),
    has: (key) => map.has(key),
    delete: (key) => lruDelete(map, key, onEvict),
    clear: () => lruClear(map, onEvict),
    get size(): number {
      return map.size;
    },
  };
}

function codeModes(ctx: ViewerModeContext): PreviewMode[] {
  return ctx.hasDiff || ctx.currentMode === "diff" ? ["source", "diff"] : ["source"];
}

function richModes(ctx: ViewerModeContext): PreviewMode[] {
  return ctx.hasDiff || ctx.currentMode === "diff"
    ? ["preview", "source", "diff"]
    : ["preview", "source"];
}

function imageModes(ctx: ViewerModeContext): PreviewMode[] {
  return ctx.mimeType === "image/svg+xml" ? richModes(ctx) : ["preview"];
}

function diffModes(): PreviewMode[] {
  return ["diff", "source"];
}

function opaqueModes(): PreviewMode[] {
  return ["preview"];
}

/** Single source of truth for per-FileKind I/O, prewarm, mode pills, and default badges. */
export const VIEWER_SPECS: Readonly<Record<FileKind, ViewerSpec>> = {
  code: {
    io: "text",
    editable: true,
    canPrewarm: true,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "source",
    badge: "≡",
    modes: codeModes,
  },
  markdown: {
    io: "text",
    editable: true,
    canPrewarm: true,
    hasRichPreview: true,
    rawModeLabel: "Markdown",
    defaultMode: "preview",
    badge: "M↓",
    modes: richModes,
  },
  mermaid: {
    io: "text",
    editable: true,
    canPrewarm: false,
    hasRichPreview: true,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "M◇",
    modes: richModes,
  },
  html: {
    io: "text",
    editable: true,
    canPrewarm: false,
    hasRichPreview: true,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "<>",
    modes: richModes,
  },
  table: {
    io: "text",
    editable: true,
    canPrewarm: false,
    hasRichPreview: true,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "⊞",
    modes: richModes,
  },
  diff: {
    io: "text",
    editable: true,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "diff",
    badge: "±",
    modes: diffModes,
  },
  image: {
    io: "bytes",
    editable: false,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "IMG",
    modes: imageModes,
  },
  video: {
    io: "stat",
    editable: false,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "VID",
    modes: opaqueModes,
  },
  audio: {
    io: "stat",
    editable: false,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "AUD",
    modes: opaqueModes,
  },
  quicklook: {
    io: "stat",
    editable: false,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "PDF",
    modes: opaqueModes,
  },
  binary: {
    io: "bytes",
    editable: false,
    canPrewarm: false,
    hasRichPreview: false,
    rawModeLabel: "Code",
    defaultMode: "preview",
    badge: "≡",
    modes: opaqueModes,
  },
};

/**
 * A cell that reads as a number (spaces around it allowed) becomes one, so a table
 * sorts numerically. A leading zero (`007`, a code or an id) keeps it text.
 */
const NUMERIC_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** The language shown in the editor for a file name that has no extension. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  justfile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  brewfile: "ruby",
  ".gitignore": "gitignore",
  ".dockerignore": "gitignore",
  ".gitattributes": "gitignore",
  ".env": "dotenv",
  ".env.local": "dotenv",
  ".env.example": "dotenv",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".babelrc": "json",
  ".zshrc": "bash",
  ".bashrc": "bash",
  ".zprofile": "bash",
  "cmakelists.txt": "cmake",
};

/** The language shown in the editor for a file extension. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mmd: "mermaid",
  mermaid: "mermaid",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  php: "php",
  pl: "perl",
  r: "r",
  dart: "dart",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  jl: "julia",
  gradle: "groovy",
  groovy: "groovy",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  hcl: "hcl",
  nix: "nix",
  cmake: "cmake",
  bat: "batch",
  cmd: "batch",
  srt: "srt",
  vtt: "vtt",
  ass: "ini",
  lock: "toml",
  env: "dotenv",
  txt: "plaintext",
  log: "plaintext",
};

const CODE_BADGE_BY_LANGUAGE: Record<string, string> = {
  typescript: "TS",
  tsx: "TS",
  javascript: "JS",
  jsx: "JS",
  json: "{}",
};

/** Build a classification record from its kind, language, and MIME type. */
function rule(kind: FileKind, language: string, mimeType: string): FileClassification {
  return { kind, language, defaultMode: VIEWER_SPECS[kind].defaultMode, mimeType };
}

/** Extensions whose preview is decided before the NUL-byte binary check. */
const EXTENSION_RULES: Record<string, FileClassification> = {
  // Markdown documents.
  md: rule("markdown", "markdown", "text/markdown"),
  markdown: rule("markdown", "markdown", "text/markdown"),
  mdx: rule("markdown", "markdown", "text/markdown"),
  // Standalone Mermaid diagram files.
  mmd: rule("mermaid", "mermaid", "text/vnd.mermaid"),
  mermaid: rule("mermaid", "mermaid", "text/vnd.mermaid"),
  // HTML pages.
  html: rule("html", "html", "text/html"),
  htm: rule("html", "html", "text/html"),
  // Table data.
  csv: rule("table", "csv", "text/csv"),
  tsv: rule("table", "tsv", "text/tab-separated-values"),
  jsonl: rule("table", "jsonl", "application/x-ndjson"),
  ndjson: rule("table", "jsonl", "application/x-ndjson"),
  // Diffs and patches.
  diff: rule("diff", "diff", "text/x-diff"),
  patch: rule("diff", "diff", "text/x-diff"),
  // Images and vector graphics.
  png: rule("image", "", "image/png"),
  jpg: rule("image", "", "image/jpeg"),
  jpeg: rule("image", "", "image/jpeg"),
  gif: rule("image", "", "image/gif"),
  webp: rule("image", "", "image/webp"),
  avif: rule("image", "", "image/avif"),
  heic: rule("image", "", "image/heic"),
  heif: rule("image", "", "image/heif"),
  tiff: rule("image", "", "image/tiff"),
  tif: rule("image", "", "image/tiff"),
  icns: rule("image", "", "image/icns"),
  bmp: rule("image", "", "image/bmp"),
  ico: rule("image", "", "image/x-icon"),
  svg: rule("image", "xml", "image/svg+xml"),
  // Video streams rendered natively via macOS AVPlayerView.
  mp4: rule("video", "", "video/mp4"),
  mov: rule("video", "", "video/quicktime"),
  webm: rule("video", "", "video/webm"),
  m4v: rule("video", "", "video/x-m4v"),
  mkv: rule("video", "", "video/x-matroska"),
  avi: rule("video", "", "video/x-msvideo"),
  mpg: rule("video", "", "video/mpeg"),
  mpeg: rule("video", "", "video/mpeg"),
  ogv: rule("video", "", "video/ogg"),
  "3gp": rule("video", "", "video/3gpp"),
  // Audio streams rendered natively via macOS AVPlayerView.
  mp3: rule("audio", "", "audio/mpeg"),
  wav: rule("audio", "", "audio/wav"),
  m4a: rule("audio", "", "audio/mp4"),
  aac: rule("audio", "", "audio/aac"),
  flac: rule("audio", "", "audio/flac"),
  ogg: rule("audio", "", "audio/ogg"),
  oga: rule("audio", "", "audio/ogg"),
  opus: rule("audio", "", "audio/opus"),
  caf: rule("audio", "", "audio/x-caf"),
  aiff: rule("audio", "", "audio/aiff"),
  aif: rule("audio", "", "audio/aiff"),
  // PDF rendered via `sips`; Office/iWork/RTF stay opaque binary so `sips` is never spawned on them.
  pdf: rule("quicklook", "", "application/pdf"),
  doc: rule("binary", "plaintext", "application/msword"),
  docx: rule(
    "binary",
    "plaintext",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ),
  xls: rule("binary", "plaintext", "application/vnd.ms-excel"),
  xlsx: rule(
    "binary",
    "plaintext",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ),
  ppt: rule("binary", "plaintext", "application/vnd.ms-powerpoint"),
  pptx: rule(
    "binary",
    "plaintext",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ),
  pages: rule("binary", "plaintext", "application/vnd.apple.pages"),
  numbers: rule("binary", "plaintext", "application/vnd.apple.numbers"),
  key: rule("binary", "plaintext", "application/vnd.apple.keynote"),
  rtf: rule("binary", "plaintext", "application/rtf"),
};

/** The lower-case extension of a path or file name, without the dot; "" when it has none. */
export function extensionOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The lower-case base name of a path. */
function baseName(filePath: string): string {
  const name = path.basename(filePath);
  return name.length > 0 ? name.toLowerCase() : filePath.toLowerCase();
}

/** Concise monochrome badge glyph for a path; extensionless names like `ts` or `pdf` get `≡`. */
export function badgeForPath(filePath: string): string {
  const ext = extensionOf(filePath);
  if (!ext) return "≡";
  if (ext === "svg") return "SVG";
  const known = EXTENSION_RULES[ext];
  if (known) return known.language === "jsonl" ? "{}" : VIEWER_SPECS[known.kind].badge;
  const lang = LANGUAGE_BY_EXTENSION[ext];
  return (lang && CODE_BADGE_BY_LANGUAGE[lang]) || "≡";
}

/** MIME type when `filePath` classifies as an image, or null otherwise. */
export function imageMimeForPath(filePath: string): string | null {
  const c = classifyFile(filePath);
  return c.kind === "image" ? c.mimeType : null;
}

/** Whether the leading bytes hold a NUL, the mark of a binary file. */
function containsNullByte(bytes?: Uint8Array): boolean {
  if (!bytes) return false;
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** The language of a code file, from its name then its extension. */
function languageFor(name: string, ext: string): string {
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;
  const byExtension = LANGUAGE_BY_EXTENSION[ext];
  if (byExtension) return byExtension;
  return ext.length > 0 ? ext : "plaintext";
}

/** Classify a file by its path and optional leading bytes (up to 4 KB). */
export function classifyFile(filePath: string, sampleBytes?: Uint8Array): FileClassification {
  const name = baseName(filePath);
  const ext = extensionOf(name);
  const known = EXTENSION_RULES[ext];
  if (known) return { ...known };
  if (containsNullByte(sampleBytes)) {
    return rule("binary", "plaintext", "application/octet-stream");
  }
  return rule("code", languageFor(name, ext), "text/plain");
}

/** Split text into lines, dropping the single trailing newline. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Drop a trailing line that was cut mid-stream (no terminating `\n` or `\r`). */
function dropUnterminatedLine(text: string): string {
  if (!text || text.endsWith("\n") || text.endsWith("\r")) return text;
  const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return cut >= 0 ? text.slice(0, cut + 1) : "";
}

/** One column, keyed by its index so an array row lines up with it. */
function makeColumn(index: number, title: string): DataTableColumn {
  return {
    key: String(index),
    title: title.length > 0 ? title : `Column ${index + 1}`,
    width: 140,
    sortable: true,
    resizable: true,
  };
}

/** A cell that reads as a number becomes one; everything else stays text. */
function toCellValue(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  const text = String(value);
  const trimmed = text.trim();
  return NUMERIC_PATTERN.test(trimmed) ? Number(trimmed) : text;
}

/** A quoted cell's text from just after its opening quote (`""` is one `"`), scanned in plain slices. */
function readQuotedCell(text: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start;
  while (i < text.length) {
    const q = text.indexOf('"', i);
    if (q < 0) return { value: value + text.slice(i), end: text.length };
    value += text.slice(i, q);
    if (text[q + 1] !== '"') return { value, end: q + 1 };
    value += '"';
    i = q + 2;
  }
  return { value, end: i };
}

interface DelimitedCursor {
  nextDelim: number;
  nextNl: number;
  nextQuote: number;
}

function advancePos(body: string, needle: string, pos: number, cached: number): number {
  return cached >= 0 && cached < pos ? body.indexOf(needle, pos) : cached;
}

function nextPlainStop(body: string, pos: number, delimiter: string, cur: DelimitedCursor): number {
  cur.nextDelim = advancePos(body, delimiter, pos, cur.nextDelim);
  cur.nextNl = advancePos(body, "\n", pos, cur.nextNl);
  cur.nextQuote = advancePos(body, '"', pos, cur.nextQuote);
  let stop = cur.nextNl;
  if (cur.nextDelim >= 0 && cur.nextDelim < stop) stop = cur.nextDelim;
  if (cur.nextQuote >= 0 && cur.nextQuote < stop) stop = cur.nextQuote;
  return stop;
}

/**
 * Split CSV or TSV text into records of cells. A double-quoted cell may hold the
 * delimiter, line breaks and `""` escapes; plain runs scan via `indexOf` slices.
 */
export function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  if (!text) return [];
  if (!text.includes('"')) return splitLines(text).map((line) => line.split(delimiter));
  const lf = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  const body = lf.endsWith("\n") ? lf : `${lf}\n`;
  const cur: DelimitedCursor = {
    nextDelim: body.indexOf(delimiter, 0),
    nextNl: body.indexOf("\n", 0),
    nextQuote: body.indexOf('"', 0),
  };
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const quoted = readQuotedCell(body, i + 1);
      cell += quoted.value;
      i = quoted.end;
    } else if (ch === delimiter) {
      record.push(cell);
      cell = "";
      i += 1;
    } else if (ch === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      i += 1;
    } else {
      const stop = nextPlainStop(body, i, delimiter, cur);
      cell += body.slice(i, stop);
      i = stop;
    }
  }
  return records;
}

/** Parse CSV or TSV text: the first record is the header, the rest are rows. */
function parseDelimited(text: string, delimiter: string, partial = false): TableData {
  const src = partial ? dropUnterminatedLine(text) : text;
  const records = parseDelimitedRecords(src, delimiter);
  if (records.length === 0) return { columns: [], rows: [], invalidLines: [] };
  const columns = records[0].map((title, index) => makeColumn(index, title.trim()));
  const rows = records.slice(1).map((record) => record.map(toCellValue));
  return { columns, rows, invalidLines: [] };
}

/** One JSON object per line, or null when the line is not one. */
function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function appendJsonlRow(
  obj: Record<string, unknown>,
  keys: string[],
  keyIndex: Map<string, number>,
  rows: (string | number)[][],
): void {
  const row = Array.from({ length: keys.length }, (): string | number => "");
  for (const key of Object.keys(obj)) {
    let col = keyIndex.get(key);
    if (col === undefined) {
      col = keys.length;
      keyIndex.set(key, col);
      keys.push(key);
    }
    row[col] = toCellValue(obj[key]);
  }
  rows.push(row);
}

function padRowsToWidth(rows: (string | number)[][], width: number): void {
  for (const row of rows) {
    while (row.length < width) row.push("");
  }
}

/** Stream JSONL/NDJSON lines directly into `rows` without keeping a second `objects[]` array. */
export function parseJsonl(text: string, partial = false): TableData {
  const src = partial ? dropUnterminatedLine(text) : text;
  if (!src) return { columns: [], rows: [], invalidLines: [] };
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  const rows: (string | number)[][] = [];
  const invalidLines: number[] = [];
  let pos = 0;
  let lineNo = 1;
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos);
    const rawLine = nl >= 0 ? src.slice(pos, nl) : src.slice(pos);
    pos = nl >= 0 ? nl + 1 : src.length;
    const trimmed = rawLine.trim();
    if (trimmed.length > 0) {
      const parsed = parseJsonObject(trimmed);
      if (parsed) appendJsonlRow(parsed, keys, keyIndex, rows);
      else invalidLines.push(lineNo);
    }
    lineNo += 1;
  }
  padRowsToWidth(rows, keys.length);
  const columns = keys.map((key, index) => makeColumn(index, key));
  return { columns, rows, invalidLines };
}

/** Parse CSV, TSV, JSONL, or NDJSON text into DataTable columns and rows. */
export function parseTableData(text: string, filePath: string, partial = false): TableData {
  const ext = extensionOf(filePath);
  if (ext === "jsonl" || ext === "ndjson") return parseJsonl(text, partial);
  return parseDelimited(text, ext === "tsv" ? "\t" : ",", partial);
}

/** One hex group, padded so the ASCII column always starts at the same place. */
function hexGroup(parts: string[]): string {
  return parts.join(" ").padEnd(23, " ");
}

/** One 16-byte line: offset, hex bytes in two groups, then the printable ASCII. */
function formatHexLine(bytes: Uint8Array, start: number, end: number): string {
  const offset = start.toString(16).padStart(8, "0");
  const hex: string[] = [];
  let ascii = "";
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    hex.push(byte.toString(16).padStart(2, "0"));
    ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
  }
  return `${offset}  ${hexGroup(hex.slice(0, 8))}  ${hexGroup(hex.slice(8))}  |${ascii}|`;
}

/** Format leading bytes (up to 4 KB) as a classic hex + ASCII dump. */
export function formatHexDump(bytes: Uint8Array, maxBytes = 4096): string {
  const total = Math.min(bytes.length, Math.max(0, maxBytes));
  if (total === 0) return "(empty file)";
  const lines: string[] = [];
  for (let offset = 0; offset < total; offset += 16) {
    lines.push(formatHexLine(bytes, offset, Math.min(offset + 16, total)));
  }
  if (total < bytes.length) lines.push(`... ${bytes.length - total} more bytes`);
  return lines.join("\n");
}

/** Create a zero-copy blob: URL from raw file bytes and MIME type. */
export function createBlobUrl(bytes: Uint8Array, mimeType: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function readU32BE(b: Uint8Array, offset: number): number {
  return (
    ((b[offset] << 24) >>> 0) |
    (b[offset + 1] << 16) |
    (b[offset + 2] << 8) |
    b[offset + 3]
  );
}

function readU16LE(b: Uint8Array, offset: number): number {
  return b[offset] | (b[offset + 1] << 8);
}

function probePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49) return null;
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeSvgDimensions(text: string): ImageDimensions | null {
  const vb = text.match(/viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) {
    return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
  }
  const w = text.match(/\bwidth=["'](\d+)/i);
  const h = text.match(/\bheight=["'](\d+)/i);
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  return null;
}

/** Extract pixel dimensions from PNG, GIF, or SVG headers when available. */
export function probeImageDimensions(
  bytes: Uint8Array,
  text?: string,
): ImageDimensions | null {
  const png = probePngDimensions(bytes);
  if (png) return png;
  const gif = probeGifDimensions(bytes);
  if (gif) return gif;
  return text ? probeSvgDimensions(text) : null;
}

export interface QuickLookLoaderDeps {
  maxEntries?: number;
  statVersion: (filePath: string) => Promise<string | null>;
  renderPdfUrl: (filePath: string, cwd: string, outDir: string) => Promise<string | null>;
  revokeUrl?: (url: string) => void;
}

interface QuickLookState {
  deps: QuickLookLoaderDeps;
  latestKeyByPath: Map<string, string>;
  cache: LruCache<string, string>;
  inflight: Map<string, Promise<string | null>>;
}

function evictQuickLookKey(
  evictedKey: string,
  url: string,
  latestKeyByPath: Map<string, string>,
  revoke: (url: string) => void,
): void {
  const sep = evictedKey.indexOf("\0");
  const evictedPath = sep >= 0 ? evictedKey.slice(0, sep) : evictedKey;
  if (latestKeyByPath.get(evictedPath) === evictedKey) {
    latestKeyByPath.delete(evictedPath);
  }
  revoke(url);
}

async function loadQuickLookEntry(
  st: QuickLookState,
  filePath: string,
  cwd: string,
  outDir: string,
): Promise<string | null> {
  const version = await st.deps.statVersion(filePath);
  if (!version) return null;
  const cacheKey = `${filePath}\0${version}`;
  const cached = st.cache.get(cacheKey);
  if (cached) return cached;
  const url = await st.deps.renderPdfUrl(filePath, cwd, outDir);
  if (!url) return null;
  const prevKey = st.latestKeyByPath.get(filePath);
  if (prevKey && prevKey !== cacheKey) st.cache.delete(prevKey);
  st.latestKeyByPath.set(filePath, cacheKey);
  st.cache.set(cacheKey, url);
  return url;
}

function runCoalescedQuickLook(
  st: QuickLookState,
  filePath: string,
  cwd: string,
  outDir: string,
): Promise<string | null> {
  const existing = st.inflight.get(filePath);
  if (existing) return existing;
  const task = loadQuickLookEntry(st, filePath, cwd, outDir)
    .catch(() => null)
    .finally(() => {
      st.inflight.delete(filePath);
    });
  st.inflight.set(filePath, task);
  return task;
}

/** Build a bounded LRU QuickLook loader with inflight Promise deduplication and URL revocation. */
export function createQuickLookLoader(
  deps: QuickLookLoaderDeps,
): (filePath: string, cwd?: string, outDir?: string) => Promise<string | null> {
  const revoke = deps.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const latestKeyByPath = new Map<string, string>();
  const cache = createLruCache<string, string>(deps.maxEntries ?? 16, (key, url) => {
    evictQuickLookKey(key, url, latestKeyByPath, revoke);
  });
  const st: QuickLookState = { deps, latestKeyByPath, cache, inflight: new Map() };
  return (filePath: string, cwd = "", outDir = "") =>
    runCoalescedQuickLook(st, filePath, cwd, outDir);
}

async function renderSipsPdfUrl(
  filePath: string,
  cwd: string,
  outDir: string,
): Promise<string | null> {
  await fs.mkdir(outDir, { recursive: true });
  const pngPath = path.join(outDir, `${crypto.randomUUID()}.png`);
  try {
    await process.run(
      "sips",
      ["-Z", "1800", "-s", "format", "png", filePath, "--out", pngPath],
      { cwd },
    );
    const bytes = await fs.readFile(pngPath);
    return createBlobUrl(bytes, "image/png");
  } finally {
    await fs.unlink(pngPath).catch(() => undefined);
  }
}

const defaultQuickLookLoader = createQuickLookLoader({
  maxEntries: 16,
  statVersion: async (filePath) => {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  },
  renderPdfUrl: renderSipsPdfUrl,
});

/**
 * Make a macOS 2x Retina preview PNG of a PDF's first page with `sips`, in
 * `outDir` (Aed's per-user cache, DESIGN.md「术语与边界」), and return it as a
 * blob: URL, or null on failure. The PNG is deleted as soon as it is read.
 */
export function generateQuickLookUrl(
  filePath: string,
  cwd: string,
  outDir: string,
): Promise<string | null> {
  return defaultQuickLookLoader(filePath, cwd, outDir);
}
