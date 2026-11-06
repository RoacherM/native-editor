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

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface TableData {
  columns: DataTableColumn[];
  rows: (string | number)[][];
}

export interface FileClassification {
  kind: FileKind;
  language: string;
  defaultMode: PreviewMode;
  supportsPreview: boolean;
  mimeType: string;
}

/** The directory PDF preview thumbnails are cached in (inside the /tmp grant). */
const QUICK_LOOK_DIR = "/tmp/aed-ql";

/** A cell that reads as a number becomes one, so a table sorts numerically. */
const NUMERIC_PATTERN = /^-?\d+(?:\.\d+)?$/;

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

/** Build a classification record from its parts. */
function rule(
  kind: FileKind,
  language: string,
  defaultMode: PreviewMode,
  supportsPreview: boolean,
  mimeType: string,
): FileClassification {
  return { kind, language, defaultMode, supportsPreview, mimeType };
}

/** Extensions whose preview is decided before the NUL-byte binary check. */
const EXTENSION_RULES: Record<string, FileClassification> = {
  // Markdown documents.
  md: rule("markdown", "markdown", "preview", true, "text/markdown"),
  markdown: rule("markdown", "markdown", "preview", true, "text/markdown"),
  mdx: rule("markdown", "markdown", "preview", true, "text/markdown"),
  // Standalone Mermaid diagram files.
  mmd: rule("mermaid", "mermaid", "preview", true, "text/vnd.mermaid"),
  mermaid: rule("mermaid", "mermaid", "preview", true, "text/vnd.mermaid"),
  // HTML pages.
  html: rule("html", "html", "preview", true, "text/html"),
  htm: rule("html", "html", "preview", true, "text/html"),
  // Table data.
  csv: rule("table", "csv", "preview", true, "text/csv"),
  tsv: rule("table", "tsv", "preview", true, "text/tab-separated-values"),
  jsonl: rule("table", "jsonl", "preview", true, "application/x-ndjson"),
  // Diffs and patches.
  diff: rule("diff", "diff", "diff", true, "text/x-diff"),
  patch: rule("diff", "diff", "diff", true, "text/x-diff"),
  // Images and vector graphics.
  png: rule("image", "", "preview", true, "image/png"),
  jpg: rule("image", "", "preview", true, "image/jpeg"),
  jpeg: rule("image", "", "preview", true, "image/jpeg"),
  gif: rule("image", "", "preview", true, "image/gif"),
  webp: rule("image", "", "preview", true, "image/webp"),
  avif: rule("image", "", "preview", true, "image/avif"),
  heic: rule("image", "", "preview", true, "image/heic"),
  heif: rule("image", "", "preview", true, "image/heif"),
  tiff: rule("image", "", "preview", true, "image/tiff"),
  tif: rule("image", "", "preview", true, "image/tiff"),
  icns: rule("image", "", "preview", true, "image/icns"),
  bmp: rule("image", "", "preview", true, "image/bmp"),
  ico: rule("image", "", "preview", true, "image/x-icon"),
  svg: rule("image", "xml", "preview", true, "image/svg+xml"),
  // Video streams rendered natively via macOS AVPlayerView.
  mp4: rule("video", "", "preview", true, "video/mp4"),
  mov: rule("video", "", "preview", true, "video/quicktime"),
  webm: rule("video", "", "preview", true, "video/webm"),
  m4v: rule("video", "", "preview", true, "video/x-m4v"),
  mkv: rule("video", "", "preview", true, "video/x-matroska"),
  avi: rule("video", "", "preview", true, "video/x-msvideo"),
  mpg: rule("video", "", "preview", true, "video/mpeg"),
  mpeg: rule("video", "", "preview", true, "video/mpeg"),
  ogv: rule("video", "", "preview", true, "video/ogg"),
  "3gp": rule("video", "", "preview", true, "video/3gpp"),
  // Audio streams rendered natively via macOS AVPlayerView.
  mp3: rule("audio", "", "preview", true, "audio/mpeg"),
  wav: rule("audio", "", "preview", true, "audio/wav"),
  m4a: rule("audio", "", "preview", true, "audio/mp4"),
  aac: rule("audio", "", "preview", true, "audio/aac"),
  flac: rule("audio", "", "preview", true, "audio/flac"),
  ogg: rule("audio", "", "preview", true, "audio/ogg"),
  oga: rule("audio", "", "preview", true, "audio/ogg"),
  opus: rule("audio", "", "preview", true, "audio/opus"),
  caf: rule("audio", "", "preview", true, "audio/x-caf"),
  aiff: rule("audio", "", "preview", true, "audio/aiff"),
  aif: rule("audio", "", "preview", true, "audio/aiff"),
  // System documents rendered through Quick Look.
  pdf: rule("quicklook", "", "preview", true, "application/pdf"),
  doc: rule("quicklook", "", "preview", true, "application/msword"),
  docx: rule(
    "quicklook",
    "",
    "preview",
    true,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ),
  xls: rule("quicklook", "", "preview", true, "application/vnd.ms-excel"),
  xlsx: rule(
    "quicklook",
    "",
    "preview",
    true,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ),
  ppt: rule("quicklook", "", "preview", true, "application/vnd.ms-powerpoint"),
  pptx: rule(
    "quicklook",
    "",
    "preview",
    true,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ),
  pages: rule("quicklook", "", "preview", true, "application/vnd.apple.pages"),
  numbers: rule("quicklook", "", "preview", true, "application/vnd.apple.numbers"),
  key: rule("quicklook", "", "preview", true, "application/vnd.apple.keynote"),
  rtf: rule("quicklook", "", "preview", true, "application/rtf"),
};

/** The lower-case extension of a file name, without the dot; "" when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1);
}

/** The lower-case base name of a path. */
function baseName(filePath: string): string {
  const name = path.basename(filePath);
  return name.length > 0 ? name.toLowerCase() : filePath.toLowerCase();
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
    return rule("binary", "plaintext", "preview", false, "application/octet-stream");
  }
  return rule("code", languageFor(name, ext), "source", false, "text/plain");
}

/** Split text into lines, dropping the single trailing newline. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
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
  return NUMERIC_PATTERN.test(text) ? Number(text) : text;
}

/** Split one delimited line, honouring double-quoted cells with "" escapes. */
function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** Parse CSV or TSV text: the first line is the header, the rest are rows. */
function parseDelimited(text: string, delimiter: string): TableData {
  const lines = splitLines(text);
  if (lines.length === 0) return { columns: [], rows: [] };
  const header = parseDelimitedLine(lines[0], delimiter);
  const columns = header.map((title, index) => makeColumn(index, title.trim()));
  const rows = lines
    .slice(1)
    .map((line) => parseDelimitedLine(line, delimiter).map(toCellValue));
  return { columns, rows };
}

/** The field names of the parsed JSONL objects, in first-seen order. */
function collectKeys(objects: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/** Parse one JSON object per line; malformed lines are skipped. */
function parseJsonl(text: string): TableData {
  const objects: Record<string, unknown>[] = [];
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A malformed line does not stop the table.
    }
  }
  const keys = collectKeys(objects);
  const columns = keys.map((key, index) => makeColumn(index, key));
  const rows = objects.map((object) => keys.map((key) => toCellValue(object[key])));
  return { columns, rows };
}

/** Parse CSV, TSV, or JSONL text into DataTable columns and rows. */
export function parseTableData(text: string, filePath: string): TableData {
  const ext = extensionOf(baseName(filePath));
  if (ext === "jsonl") return parseJsonl(text);
  return parseDelimited(text, ext === "tsv" ? "\t" : ",");
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
  text?: string
): ImageDimensions | null {
  const png = probePngDimensions(bytes);
  if (png) return png;
  const gif = probeGifDimensions(bytes);
  if (gif) return gif;
  return text ? probeSvgDimensions(text) : null;
}

/** Generate a macOS 2x Retina preview PNG for a PDF document via CoreGraphics `sips` and return a blob: URL, or null on failure. */
export async function generateQuickLookUrl(filePath: string, cwd: string): Promise<string | null> {
  try {
    await fs.mkdir(QUICK_LOOK_DIR, { recursive: true });
    const pngPath = path.join(QUICK_LOOK_DIR, `${path.basename(filePath)}.png`);
    await process.run(
      "sips",
      ["-Z", "1800", "-s", "format", "png", filePath, "--out", pngPath],
      { cwd }
    );
    const bytes = await fs.readFile(pngPath);
    return createBlobUrl(bytes, "image/png");
  } catch {
    return null;
  }
}
