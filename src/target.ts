import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { extensionOf } from "./classify";

export { extensionOf };

/** A place in a file: `line` and `column` are 1-based, or `0` when omitted. */
export interface FileLocation {
  path: string;
  line: number;
  column: number;
}

export interface TargetOptions {
  baseDir?: string;
  homeDir?: string;
}

export type ParsedTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "candidates"; items: FileLocation[] }
  | { kind: "none" };

export type ResolvedTarget =
  | { kind: "external"; url: string }
  | {
      kind: "file";
      path: string;
      line: number;
      column: number;
      isDirectory: boolean;
    };

export interface TargetStat {
  isDirectory: boolean | (() => boolean);
}

export type StatFn = (
  candidatePath: string,
) => Promise<TargetStat | null | undefined> | TargetStat | null | undefined;

const HASH_LINE = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i;
const TRAILING_COLON_NUM = /^(.+):(\d+)$/;
const URI_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/;
const NUMERIC_COLON_REST = /^\d+(?::\d+)*(?:[?#].*)?$/;

const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "vbscript",
  "blob",
  "about",
  "tel",
  "sms",
  "urn",
  "magnet",
  "ws",
  "wss",
  "ftp",
  "sftp",
  "ssh",
  "git",
  "irc",
  "view-source",
]);

/** Normalize a directory path without trailing slashes (`/` stays `/`, blank stays `""`). */
export function normalizeDirPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  const normalized = path.normalize(trimmed);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

type SchemeRoute =
  | { kind: "external"; url: string }
  | { kind: "fileUrl"; rest: string }
  | { kind: "blocked" };

function routeWebOrFileScheme(scheme: string, rest: string, full: string): SchemeRoute | null {
  if (scheme === "file") {
    return rest.startsWith("//") ? { kind: "fileUrl", rest: rest.slice(2) } : { kind: "blocked" };
  }
  if (scheme === "mailto") {
    return rest.length > 0 ? { kind: "external", url: full } : { kind: "blocked" };
  }
  if (scheme === "http" || scheme === "https") {
    return rest.startsWith("//") ? { kind: "external", url: full } : { kind: "blocked" };
  }
  return null;
}

function classifyScheme(trimmed: string): SchemeRoute | null {
  const match = URI_SCHEME.exec(trimmed);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  const primary = routeWebOrFileScheme(scheme, rest, trimmed);
  if (primary) return primary;
  if (BLOCKED_SCHEMES.has(scheme) || rest.startsWith("//")) return { kind: "blocked" };
  return NUMERIC_COLON_REST.test(rest) ? null : { kind: "blocked" };
}

function splitQueryAndFragment(input: string): { base: string; fragment: string } {
  const hashIdx = input.indexOf("#");
  const beforeHash = hashIdx >= 0 ? input.slice(0, hashIdx) : input;
  const fragment = hashIdx >= 0 ? input.slice(hashIdx) : "";
  const queryIdx = beforeHash.indexOf("?");
  const base = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  return { base, fragment };
}

/** Decode `%XX` escapes; returns `null` if decoding introduces a NUL byte (`%00`). */
function decodePercentSafe(raw: string): string | null {
  let decoded = raw;
  if (raw.includes("%")) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
  }
  return decoded.includes("\0") ? null : decoded;
}

function splitHashLine(fragment: string): { line: number; column: number } {
  const match = HASH_LINE.exec(fragment);
  if (!match) return { line: 0, column: 0 };
  return { line: Number(match[1]), column: Number(match[2] ?? 0) };
}

interface CandidateList {
  items: FileLocation[];
  seen: Set<string>;
  baseDir: string;
  homeDir: string;
}

function addCandidate(list: CandidateList, candidate: FileLocation): void {
  const key = `${candidate.path}\0${candidate.line}\0${candidate.column}`;
  if (list.seen.has(key)) return;
  list.seen.add(key);
  list.items.push(candidate);
}

function expandHomeAndBase(rawPath: string, baseDir: string, homeDir: string): string {
  let target = rawPath;
  if (homeDir && (target === "~" || target.startsWith("~/"))) {
    target = target === "~" ? homeDir : path.join(homeDir, target.slice(2));
  }
  if (target.startsWith("/")) return path.normalize(target);
  return baseDir ? path.resolve(baseDir, target) : path.normalize(target);
}

function pushLocalCandidate(
  list: CandidateList,
  rawPath: string,
  line: number,
  column: number,
): void {
  if (!rawPath || rawPath.includes("\0")) return;
  addCandidate(list, {
    path: expandHomeAndBase(rawPath, list.baseDir, list.homeDir),
    line,
    column,
  });
}

function appendColonStripped(
  rawBase: string,
  emit: (decodedPath: string, line: number, column: number) => void,
): void {
  const first = TRAILING_COLON_NUM.exec(rawBase);
  if (!first) return;
  const prefix1 = first[1];
  const n1 = Number(first[2]);
  const dec1 = decodePercentSafe(prefix1);
  if (dec1) emit(dec1, n1, 0);

  const second = TRAILING_COLON_NUM.exec(prefix1);
  if (!second) return;
  const dec2 = decodePercentSafe(second[1]);
  if (dec2) emit(dec2, Number(second[2]), n1);
}

function extractFileUrlRawPath(afterSlashes: string): string | null {
  if (afterSlashes.startsWith("/")) return afterSlashes;
  if (/^localhost\//i.test(afterSlashes)) return afterSlashes.slice("localhost".length);
  return null;
}

function parseFileUrl(afterSlashes: string): ParsedTarget {
  const rawUrlPart = extractFileUrlRawPath(afterSlashes);
  if (!rawUrlPart) return { kind: "none" };
  const { base, fragment } = splitQueryAndFragment(rawUrlPart);
  const decoded = decodePercentSafe(base);
  if (!decoded) return { kind: "none" };

  const anchored = splitHashLine(fragment);
  const list: CandidateList = { items: [], seen: new Set(), baseDir: "", homeDir: "" };
  addCandidate(list, {
    path: path.normalize(decoded),
    line: anchored.line,
    column: anchored.column,
  });

  if (!fragment) {
    appendColonStripped(base, (p, line, column) => {
      addCandidate(list, { path: path.normalize(p), line, column });
    });
  }
  return { kind: "candidates", items: list.items };
}

function resolveOptions(opts?: TargetOptions): { baseDir: string; homeDir: string } {
  const baseDir = opts?.baseDir ? normalizeDirPath(opts.baseDir) : "";
  const homeRaw = opts?.homeDir === undefined ? os.homedir() : opts.homeDir;
  return { baseDir, homeDir: normalizeDirPath(homeRaw) };
}

function parseLocalPath(raw: string, trimmed: string, opts?: TargetOptions): ParsedTarget {
  const { base, fragment } = splitQueryAndFragment(trimmed);
  if (!base) return { kind: "none" };
  const decodedBase = decodePercentSafe(base);
  if (decodedBase === null) return { kind: "none" };

  const { baseDir, homeDir } = resolveOptions(opts);
  const list: CandidateList = { items: [], seen: new Set(), baseDir, homeDir };
  if (raw !== trimmed) pushLocalCandidate(list, raw, 0, 0);
  pushLocalCandidate(list, trimmed, 0, 0);

  const anchored = splitHashLine(fragment);
  pushLocalCandidate(list, base, anchored.line, anchored.column);
  if (decodedBase !== base) {
    pushLocalCandidate(list, decodedBase, anchored.line, anchored.column);
  }
  if (anchored.line === 0) {
    appendColonStripped(base, (p, line, col) => pushLocalCandidate(list, p, line, col));
  }
  return list.items.length > 0 ? { kind: "candidates", items: list.items } : { kind: "none" };
}

function dispatchScheme(scheme: SchemeRoute): ParsedTarget {
  if (scheme.kind === "external") return scheme;
  if (scheme.kind === "fileUrl") return parseFileUrl(scheme.rest);
  return { kind: "none" };
}

/**
 * Pure target grammar shared across Terminal `⌘`-click, OSC 8 hyperlinks,
 * Markdown preview links/images, Finder open URLs, and CLI arguments.
 */
export function parseTarget(raw: string, opts?: TargetOptions): ParsedTarget {
  if (!raw || raw.includes("\0")) return { kind: "none" };
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "none" };
  if (trimmed.startsWith("#")) return { kind: "anchor", id: trimmed.slice(1) };

  const scheme = classifyScheme(trimmed);
  if (scheme) return dispatchScheme(scheme);
  return parseLocalPath(raw, trimmed, opts);
}

async function defaultStat(candidatePath: string): Promise<TargetStat | null> {
  try {
    return await fs.stat(candidatePath);
  } catch {
    return null;
  }
}

async function probeCandidate(statFn: StatFn, candidatePath: string): Promise<TargetStat | null> {
  try {
    return (await statFn(candidatePath)) ?? null;
  } catch {
    return null;
  }
}

function isDirStat(st: TargetStat): boolean {
  return typeof st.isDirectory === "function" ? st.isDirectory() : Boolean(st.isDirectory);
}

/**
 * Resolve a target against disk in candidate order (literal path first, then
 * suffix-stripped locations), running at most one `statFn` per candidate.
 */
export async function resolveTarget(
  raw: string,
  opts?: TargetOptions,
  statFn: StatFn = defaultStat,
): Promise<ResolvedTarget | null> {
  const parsed = parseTarget(raw, opts);
  if (parsed.kind === "external") return parsed;
  if (parsed.kind !== "candidates") return null;

  for (const item of parsed.items) {
    const st = await probeCandidate(statFn, item.path);
    if (!st) continue;
    const isDirectory = isDirStat(st);
    return {
      kind: "file",
      path: item.path,
      line: isDirectory ? 0 : item.line,
      column: isDirectory ? 0 : item.column,
      isDirectory,
    };
  }
  return null;
}
