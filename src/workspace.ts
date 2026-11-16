import { Buffer } from "buffer";
import { cleanup, effect, host, type Accessor } from "nsh";
import type { CommandItem, TreeItem } from "nsh/base";
import type { Dirent } from "fs/promises";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import process from "process";
import type {
  FileClassification,
  ImageDimensions,
  PreviewMode,
  TableData,
} from "./classify";
import {
  classifyFile,
  createBlobUrl,
  createLruCache,
  formatHexDump,
  generateQuickLookUrl,
  parseTableData,
  probeImageDimensions,
  VIEWER_SPECS,
} from "./classify";
import { serialize, type WindowMode } from "./session";
import {
  normalizeDirPath,
  parseTarget,
  resolveTarget,
  type FileLocation,
  type ResolvedTarget,
  type StatFn,
  type TargetOptions,
} from "./target";

export {
  normalizeDirPath,
  parseTarget,
  resolveTarget,
  type FileLocation,
  type ResolvedTarget,
  type TargetOptions,
};

export type GitStatusCode = "M" | "A" | "D" | "U" | "R";

export interface WorkspaceEntry {
  path: string;
  relPath: string;
  name: string;
  isDirectory: boolean;
  gitStatus?: GitStatusCode;
  children?: WorkspaceEntry[];
  /** A folder whose children are not all listed says why (FOLDER_NOTICES, moreItemsNotice). */
  notice?: string;
}

export interface WorkspaceSnapshot {
  root: string;
  branch: string;
  isGitRepo: boolean;
  entries: WorkspaceEntry[];
  flatFiles: WorkspaceEntry[];
  gitStatusMap: Record<string, GitStatusCode>;
  treeItemsAll: TreeItem[];
  treeItemsChanged: TreeItem[];
  commandItems: CommandItem[];
  /** Why the root itself cannot be listed (moved, deleted, unreadable); the tree is empty then. */
  rootNotice: string | null;
}

/** Single-point `fs.stat` result reused across file loads, prewarming, and tab checks. */
export interface DiskStat {
  stamp: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

interface StatLike {
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface WorkspaceIoDeps {
  stat(targetPath: string): Promise<StatLike>;
  lstat(targetPath: string): Promise<StatLike>;
  readFile(targetPath: string): Promise<Uint8Array>;
  writeFile(targetPath: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(targetPath: string): Promise<void>;
  mkdir(targetPath: string): Promise<void>;
  readdirDirents(dir: string): Promise<Array<Pick<Dirent, "name" | "isDirectory">>>;
  readdirNames(dir: string): Promise<string[]>;
  readHead(filePath: string, count: number): Promise<Uint8Array>;
  runGit(args: string[], cwd: string): Promise<{ code?: number | null; stdout: string; stderr: string }>;
}

/** The snapshot of no workspace. */
export function emptySnapshot(): WorkspaceSnapshot {
  return {
    root: "",
    branch: "",
    isGitRepo: false,
    entries: [],
    flatFiles: [],
    gitStatusMap: {},
    treeItemsAll: [],
    treeItemsChanged: [],
    commandItems: [],
    rootNotice: null,
  };
}

/** What a folder row shows instead of children Aed could not list. */
export const FOLDER_NOTICES = {
  unreadable: "Cannot read this folder",
  tooDeep: "Too deep to list",
  rootMissing: "This folder was moved or deleted.",
} as const;

/** The last row of a folder cut at MAX_DIR_ENTRIES. */
export function moreItemsNotice(count: number): string {
  return `${count} more ${count === 1 ? "item" : "items"} not shown`;
}

export interface LoadedFile {
  path: string;
  relPath: string;
  name: string;
  size: number;
  classification: FileClassification;
  mode: PreviewMode;
  gitStatus?: GitStatusCode;
  text: string;
  savedText: string;
  dirty: boolean;
  blobUrl: string | null;
  quickLookUrl: string | null;
  dimensions?: ImageDimensions | null;
  tableData: TableData | null;
  hexDump: string;
  diffPatch: string;
  /** `mtimeMs:size` of the bytes this copy came from (null when unknown). DESIGN.md「状态机清单」#3. */
  diskStamp: string | null;
  /** The disk has a newer version than this copy's unsaved edits. */
  diskChanged: boolean;
  /** The file this copy came from is gone (moved or deleted outside Aed). */
  diskMissing: boolean;
  /** The bytes started with a UTF-8 byte order mark; a save writes it back. */
  bom: boolean;
  /** Why this copy can never be saved (its bytes are not UTF-8 or >8 MB), or null. */
  readOnly: string | null;
  /** What the last save failed with, naming the path; null after a good save. */
  saveError: string | null;
}

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".nsh",
  "target",
  "dist",
  ".DS_Store",
  ".metrics",
  "Library",
  ".Trash",
  ".cache",
  ".cargo",
  ".rustup",
  ".npm",
]);

const MAX_SCAN_DEPTH = 4;
const MAX_DIR_ENTRIES = 200;
const MAX_SCAN_CONCURRENCY = 16;

function isEditableClassification(classification: FileClassification): boolean {
  return VIEWER_SPECS[classification.kind].editable || classification.mimeType === "image/svg+xml";
}

/** Whether a file of this classification can be shown in `mode`, derived from `VIEWER_SPECS`. */
export function allowsMode(classification: FileClassification, mode: PreviewMode): boolean {
  return VIEWER_SPECS[classification.kind]
    .modes({
      mimeType: classification.mimeType,
      editable: isEditableClassification(classification),
      hasDiff: true,
    })
    .includes(mode);
}

/** Whether this copy may ever be written back: editable kind decoded without loss. */
export function canSaveFile(file: {
  classification: FileClassification;
  readOnly: string | null;
}): boolean {
  return isEditableClassification(file.classification) && file.readOnly === null;
}

/** Shown above a file whose bytes are not UTF-8; such a copy is never saved. */
export const NOT_UTF8_NOTICE = "Not UTF-8 — opened read-only";

/** Files above this size are never read whole (DESIGN.md「文件大小上限」): nsh's `writeFile` caps at 8 MiB. */
export const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/** Head bytes read once via `python3` when previewing a file above `MAX_EDITABLE_BYTES`. */
export const MAX_PREVIEW_HEAD_BYTES = 262_144;
/** Leading byte window inspected for NUL bytes and formatted for binary hex dumps. */
export const BINARY_HEAD_BYTES = 4096;

/** Shown above a text file above `MAX_EDITABLE_BYTES`; such a copy is never saved. */
export const LARGE_FILE_NOTICE = "Larger than 8 MB — showing the first 256 KB, read-only";

/** Shown above a file git lists as deleted: its diff against HEAD. */
export const DELETED_FILE_NOTICE = "Deleted — showing what was removed";

/** Why a save of a copy whose file is gone fails. */
export const FILE_MISSING_REASON = "the file was moved or deleted";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function startsWithBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** Decode UTF-8 strictly, without a leading BOM (`bom` says it was there); null when the bytes are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): { text: string; bom: boolean } | null {
  const bom = startsWithBom(bytes);
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return { text: decoder.decode(bom ? bytes.subarray(3) : bytes), bom };
  } catch {
    return null;
  }
}

/** The bytes a save writes: UTF-8, behind the BOM again when the file had one. */
export function encodeUtf8(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(UTF8_BOM.length + body.length);
  out.set(UTF8_BOM, 0);
  out.set(body, UTF8_BOM.length);
  return out;
}

type ReadCompleteness = "full" | "partial";

/** The editable text of a file's bytes; `readOnly` says why it must never be saved. */
function decodeFileText(
  classification: FileClassification,
  bytes: Uint8Array,
  completeness: ReadCompleteness,
): { text: string; bom: boolean; readOnly: string | null } {
  if (!isEditableClassification(classification)) return { text: "", bom: false, readOnly: null };
  if (completeness === "partial") {
    return { text: new TextDecoder("utf-8").decode(bytes), bom: false, readOnly: LARGE_FILE_NOTICE };
  }
  const decoded = decodeUtf8(bytes);
  if (decoded) return { ...decoded, readOnly: null };
  return { text: new TextDecoder("utf-8").decode(bytes), bom: false, readOnly: NOT_UTF8_NOTICE };
}

function execCwd(cwd?: string): string {
  return cwd && cwd.length > 0 ? cwd : os.homedir();
}

const HEAD_SCRIPT =
  "import sys\nwith open(sys.argv[1], 'rb') as f: sys.stdout.write(f.read(int(sys.argv[2])).hex())";

async function defaultReadFileHead(filePath: string, count: number): Promise<Uint8Array> {
  const result = await process.run("python3", ["-c", HEAD_SCRIPT, filePath, String(count)], {
    cwd: execCwd(),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot read ${filePath}`);
  return new Uint8Array(Buffer.from(result.stdout.trim(), "hex"));
}

const DEFAULT_IO: WorkspaceIoDeps = {
  stat: (p) => fs.stat(p),
  lstat: (p) => fs.lstat(p),
  readFile: (p) => fs.readFile(p),
  writeFile: (p, data) => fs.writeFile(p, data),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
  mkdir: (p) => fs.mkdir(p, { recursive: true }),
  readdirDirents: (dir) => fs.readdir(dir, { withFileTypes: true }),
  readdirNames: (dir) => fs.readdir(dir),
  readHead: defaultReadFileHead,
  runGit: (args, cwd) => process.run("git", args, { cwd }),
};

/** Single `fs.stat` call returning `{ stamp, size, isFile, isDirectory }`, or `null` when missing/unreadable. */
export async function statDisk(
  filePath: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<DiskStat | null> {
  try {
    const st = await deps.stat(filePath);
    return {
      stamp: `${st.mtimeMs}:${st.size}`,
      size: st.size,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
    };
  } catch {
    return null;
  }
}

// DESIGN.md「术语与边界」
/** Aed's per-user cache directory; `scripts/aed_paths.h` computes the same path. */
export function aedCacheDir(): string {
  return path.join(os.homedir(), "Library", "Caches", "dev.byronwayne.aed");
}

const QUEUE_ENTRY = /^(\d+)\.path$/;
let queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queueLock.then(fn, fn);
  queueLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const LOCAL_HASH_LINE = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;
const HAS_URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Escape literal `#` inside non-URL local file names (e.g. `C#_notes.md:10`) while keeping `#L10`. */
function prepareExternalTarget(raw: string): string {
  if (!raw.includes("#")) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("#") || HAS_URI_SCHEME.test(trimmed)) return raw;
  const hashLine = LOCAL_HASH_LINE.exec(trimmed);
  if (!hashLine) return raw.replaceAll("#", "%23");
  const cut = raw.lastIndexOf(hashLine[0]);
  return raw.slice(0, cut).replaceAll("#", "%23") + raw.slice(cut);
}

/** Candidate file locations for an external path or `file://` URL, literal first (`src/target.ts`). */
export function externalFileCandidates(raw: string, opts?: TargetOptions): FileLocation[] {
  const parsed = parseTarget(prepareExternalTarget(raw), opts);
  return parsed.kind === "candidates" ? parsed.items : [];
}

/** The path an external reference names with any line suffix taken off. */
export function normalizeExternalFilePath(raw: string, opts?: TargetOptions): string {
  return externalFileCandidates(raw, opts).at(-1)?.path ?? "";
}

/** Resolve an external file/folder reference against disk (`1` `stat` per candidate via `resolveTarget`). */
export async function resolveExternalFileReference(
  raw: string,
  opts?: TargetOptions,
  statFn: StatFn = (p) => statDisk(p),
): Promise<(FileLocation & { isDirectory: boolean }) | null> {
  const resolved = await resolveTarget(prepareExternalTarget(raw), opts, statFn);
  if (!resolved || resolved.kind !== "file") return null;
  return {
    path: resolved.path,
    line: resolved.line,
    column: resolved.column,
    isDirectory: resolved.isDirectory,
  };
}

function readHostOrEnvParam(paramKey: string, ...envNames: string[]): string {
  const fromHost = host?.params?.[paramKey];
  if (typeof fromHost === "string" && fromHost.length > 0) return fromHost;
  return envNames.map((name) => process.env[name]).find((v) => v && v.length > 0) ?? "";
}

/** The file reference this window was started to open (Finder, the CLI launcher), unresolved. */
export function getInitialOpenFile(): string | null {
  const raw = readHostOrEnvParam("openFile", "AED_OPEN_FILE", "NATIVE_EDITOR_OPEN_FILE");
  return raw.trim().length > 0 ? raw : null;
}

/** This process's own queue directory (`<cache>/open-<pid>`), or null when unset or outside cache. */
export function resolveFinderQueueDir(rawOverride?: string, cacheDirOverride?: string): string | null {
  const raw = rawOverride ?? readHostOrEnvParam("openQueue", "AED_OPEN_QUEUE");
  if (!raw) return null;
  const name = path.basename(raw);
  const inCache =
    normalizeDirPath(path.dirname(raw)) === normalizeDirPath(cacheDirOverride ?? aedCacheDir());
  return inCache && /^open-\d+$/.test(name) ? raw : null;
}

async function takeQueueEntry(entryPath: string, deps: WorkspaceIoDeps): Promise<string> {
  try {
    const stat = await deps.lstat(entryPath);
    return stat.isFile() ? new TextDecoder().decode(await deps.readFile(entryPath)) : "";
  } catch {
    return "";
  } finally {
    await deps.unlink(entryPath).catch(() => undefined);
  }
}

/** Read and delete the references queued for this window, in numeric sequence order. */
export async function consumeFinderOpenQueue(
  deps: WorkspaceIoDeps = DEFAULT_IO,
  queueDirOverride?: string,
): Promise<string[]> {
  const dir = resolveFinderQueueDir(queueDirOverride);
  if (!dir) return [];
  return withQueueLock(async () => {
    let names: string[];
    try {
      if (!(await deps.lstat(dir)).isDirectory()) return [];
      names = await deps.readdirNames(dir);
    } catch {
      return [];
    }
    const entries = names
      .map((name) => QUEUE_ENTRY.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const refs: string[] = [];
    for (const [name] of entries) {
      const ref = await takeQueueEntry(path.join(dir, name), deps);
      if (ref) refs.push(ref);
    }
    return refs;
  });
}

export interface SyncWindowStateOptions {
  queueDir?: string;
  cacheDir?: string;
  deps?: WorkspaceIoDeps;
}

function activeProcessQueueDir(opts?: SyncWindowStateOptions): string | null {
  if (opts?.queueDir !== undefined) {
    return resolveFinderQueueDir(opts.queueDir, opts.cacheDir);
  }
  const envQueue = process.env.AED_OPEN_QUEUE ?? "";
  return envQueue ? resolveFinderQueueDir(envQueue, opts?.cacheDir) : null;
}

/** Write `<cache>/open-<pid>/state` (`home` / `loose` / `workspace\n<root>`) when `AED_OPEN_QUEUE` is active. */
export async function syncWindowStateFile(
  mode: WindowMode,
  root: string,
  opts?: SyncWindowStateOptions,
): Promise<void> {
  const dir = activeProcessQueueDir(opts);
  if (!dir) return;
  const deps = opts?.deps ?? DEFAULT_IO;
  const content = mode === "workspace" ? `workspace\n${root}\n` : `${mode}\n`;
  await withQueueLock(async () => {
    try {
      await deps.mkdir(dir);
      if (!(await deps.lstat(dir)).isDirectory()) return;
      const tmpPath = path.join(dir, ".state.tmp");
      const dstPath = path.join(dir, "state");
      await deps.unlink(tmpPath).catch(() => undefined);
      await deps.writeFile(tmpPath, content);
      await deps.rename(tmpPath, dstPath);
    } catch {
      // Best-effort hint for finder_bridge.m; external opens safely fall back to open -n.
    }
  });
}

/** Resolve initial workspace root from host.params.workspaceRoot or AED_ROOT; "" on clean/loose launch. */
export function getInitialWorkspaceRoot(): string {
  return readHostOrEnvParam("workspaceRoot", "AED_ROOT", "NATIVE_EDITOR_ROOT");
}

/** Check whether a path on disk is a directory via single-point `statDisk`. */
export async function isDirectoryPath(
  targetPath: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<boolean> {
  return (await statDisk(targetPath, deps))?.isDirectory ?? false;
}

/** The path of `full` relative to `root` (both absolute). */
export function relativePath(root: string, full: string): string {
  if (!root) return path.basename(full) || full;
  const cleanRoot = root.replace(/\/+$/, "");
  const prefix = `${cleanRoot}/`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

/** `full` with the home directory written as `~`, for display only. */
export function shortenHomePath(full: string, home: string): string {
  if (!home) return full;
  const cleanHome = home.replace(/\/+$/, "");
  if (full === cleanHome) return "~";
  return full.startsWith(`${cleanHome}/`) ? `~${full.slice(cleanHome.length)}` : full;
}

/** Look up git status for an absolute or relative path in `statusMap`. */
export function lookupGitStatus(
  filePath: string,
  root: string,
  statusMap: Record<string, GitStatusCode>,
): GitStatusCode | undefined {
  const rel = relativePath(root, filePath);
  return statusMap[rel] ?? statusMap[filePath];
}

function isIgnored(name: string, isDirectory: boolean): boolean {
  if (IGNORED_NAMES.has(name)) return true;
  if (isDirectory && name.startsWith(".") && name !== ".github") return true;
  return false;
}

interface DirListing {
  entries: WorkspaceEntry[];
  notice: string | null;
}

function compareDirents(
  a: Pick<Dirent, "name" | "isDirectory">,
  b: Pick<Dirent, "name" | "isDirectory">,
): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function buildScannedEntry(
  root: string,
  dir: string,
  dirent: Pick<Dirent, "name" | "isDirectory">,
  depth: number,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  deps: WorkspaceIoDeps,
): Promise<WorkspaceEntry> {
  const full = path.join(dir, dirent.name);
  const isDirectory = dirent.isDirectory();
  const entry: WorkspaceEntry = {
    path: full,
    relPath: relativePath(root, full),
    name: dirent.name,
    isDirectory,
  };
  if (!isDirectory) return entry;
  const listing = await scanDirectory(root, full, depth + 1, limit, deps);
  entry.children = listing.entries;
  if (listing.notice) entry.notice = listing.notice;
  return entry;
}

async function scanDirectory(
  root: string,
  dir: string,
  depth: number,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  deps: WorkspaceIoDeps,
): Promise<DirListing> {
  if (depth > MAX_SCAN_DEPTH) return { entries: [], notice: FOLDER_NOTICES.tooDeep };
  let dirents: Array<Pick<Dirent, "name" | "isDirectory">>;
  try {
    dirents = await limit(() => deps.readdirDirents(dir));
  } catch {
    return { entries: [], notice: FOLDER_NOTICES.unreadable };
  }
  const visible = dirents
    .filter((dirent) => !isIgnored(dirent.name, dirent.isDirectory()))
    .sort(compareDirents);
  const shown = visible.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(
    shown.map((dirent) => buildScannedEntry(root, dir, dirent, depth, limit, deps)),
  );
  const omitted = visible.length - shown.length;
  return { entries, notice: omitted > 0 ? moreItemsNotice(omitted) : null };
}

function applyGitStatusEntry(entry: WorkspaceEntry, gitStatus: GitStatusCode | undefined): WorkspaceEntry {
  if (gitStatus !== undefined) return { ...entry, gitStatus };
  if (entry.gitStatus === undefined) return entry;
  const { gitStatus: _dropped, ...clean } = entry;
  return clean;
}

/** Purely attach gitStatus across the tree while accumulating every file into a single `out` array. */
function collectFiles(
  entries: readonly WorkspaceEntry[],
  gitStatusMap: Record<string, GitStatusCode>,
  out: WorkspaceEntry[],
): WorkspaceEntry[] {
  const mapped: WorkspaceEntry[] = [];
  for (const entry of entries) {
    const gitStatus = gitStatusMap[entry.relPath];
    if (entry.isDirectory) {
      const children = collectFiles(entry.children ?? [], gitStatusMap, out);
      mapped.push({ ...applyGitStatusEntry(entry, gitStatus), children });
    } else {
      const next = applyGitStatusEntry(entry, gitStatus);
      mapped.push(next);
      out.push(next);
    }
  }
  return mapped;
}

function toTreeItems(dir: string, entries: WorkspaceEntry[], notice: string | null | undefined): TreeItem[] {
  const items = entries.map(toTreeItem);
  if (notice) items.push({ id: noticeRowId(dir), label: notice, disabled: true });
  return items;
}

function toTreeItem(entry: WorkspaceEntry): TreeItem {
  const item: TreeItem = { id: entry.path, label: entry.name };
  if (entry.isDirectory) item.children = toTreeItems(entry.path, entry.children ?? [], entry.notice);
  return item;
}

function noticeRowId(dir: string): string {
  return `${dir}/\u0000notice`;
}

function toChangedItems(
  root: string,
  flatFiles: WorkspaceEntry[],
  gitStatusMap: Record<string, GitStatusCode>,
): TreeItem[] {
  const onDisk = flatFiles
    .filter((entry) => entry.gitStatus !== undefined)
    .map((entry) => ({ id: entry.path, label: entry.relPath }));
  const listed = new Set(flatFiles.map((entry) => entry.relPath));
  const deleted = Object.keys(gitStatusMap)
    .filter((rel) => gitStatusMap[rel] === "D" && !listed.has(rel))
    .map((rel) => ({ id: path.join(root, rel), label: rel }));
  return [...onDisk, ...deleted];
}

function toCommandItem(entry: WorkspaceEntry): CommandItem {
  return { id: entry.path, label: entry.relPath, keywords: [entry.name], group: "Files" };
}

function toGitStatus(code: string): GitStatusCode {
  if (code === "??") return "U";
  if (code[0] === "R" || code[1] === "R") return "R";
  if (code[0] === "A" || code[1] === "A") return "A";
  if (code[0] === "D" || code[1] === "D") return "D";
  return "M";
}

function parseGitStatus(output: string): Record<string, GitStatusCode> {
  const map: Record<string, GitStatusCode> = {};
  const fields = output.split("\u0000");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const filePath = field.slice(3).replace(/\/+$/, "");
    if (filePath.length === 0) continue;
    map[filePath] = toGitStatus(code);
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return map;
}

async function probeGitStatus(
  root: string,
  deps: WorkspaceIoDeps,
): Promise<{ isGitRepo: boolean; gitStatusMap: Record<string, GitStatusCode> }> {
  try {
    const result = await deps.runGit(
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"],
      root,
    );
    if (result.code !== 0) return { isGitRepo: false, gitStatusMap: {} };
    return { isGitRepo: true, gitStatusMap: parseGitStatus(result.stdout) };
  } catch {
    return { isGitRepo: false, gitStatusMap: {} };
  }
}

/** Run `git --no-optional-locks status --porcelain=v1 -z -uall`; empty map outside a repository. */
export async function readGitStatus(
  root: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<Record<string, GitStatusCode>> {
  return (await probeGitStatus(root, deps)).gitStatusMap;
}

async function readGitBranch(root: string, deps: WorkspaceIoDeps): Promise<string> {
  try {
    const result = await deps.runGit(
      ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
      root,
    );
    return result.code === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function resolveUnreadableRootNotice(root: string, deps: WorkspaceIoDeps): Promise<string> {
  return (await isDirectoryPath(root, deps))
    ? FOLDER_NOTICES.unreadable
    : FOLDER_NOTICES.rootMissing;
}

/** Scan workspace directory (bounded concurrency), git repo state, branch, and lock-free git status. */
export async function scanWorkspace(
  root: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<WorkspaceSnapshot> {
  if (!root || root.trim().length === 0) return emptySnapshot();
  const limit = createLimiter(MAX_SCAN_CONCURRENCY);
  const [gitProbe, branch, listing] = await Promise.all([
    probeGitStatus(root, deps),
    readGitBranch(root, deps),
    scanDirectory(root, root, 0, limit, deps),
  ]);
  const unlisted = listing.notice === FOLDER_NOTICES.unreadable;
  const rootNotice = unlisted ? await resolveUnreadableRootNotice(root, deps) : null;
  const base: WorkspaceSnapshot = {
    ...emptySnapshot(),
    root,
    branch: gitProbe.isGitRepo ? branch : "",
    isGitRepo: gitProbe.isGitRepo,
    entries: listing.entries,
    treeItemsAll: unlisted ? [] : toTreeItems(root, listing.entries, listing.notice),
    rootNotice,
  };
  return withGitStatus(base, gitProbe.gitStatusMap);
}

const MAX_PRELOAD_FILES = 12;
const MAX_PRELOAD_CACHE_ENTRIES = 32;
const MAX_PRELOAD_BYTES = 262_144;
let preloadedRoot = "";
const preloadedFiles = createLruCache<string, LoadedFile>(MAX_PRELOAD_CACHE_ENTRIES, (_key, file) => {
  if (file.blobUrl?.startsWith("blob:")) URL.revokeObjectURL(file.blobUrl);
});

function invalidateChangedPreloads(
  root: string,
  prevMap: Record<string, GitStatusCode>,
  nextMap: Record<string, GitStatusCode>,
): void {
  if (!root) return;
  for (const rel of Object.keys(prevMap)) {
    if (prevMap[rel] !== nextMap[rel]) preloadedFiles.delete(path.join(root, rel));
  }
  for (const rel of Object.keys(nextMap)) {
    if (prevMap[rel] !== nextMap[rel]) preloadedFiles.delete(path.join(root, rel));
  }
}

/** `snapshot` with a new git status: updates badges, Changed list, quick open, and invalidates stale preloads. */
export function withGitStatus(
  snapshot: WorkspaceSnapshot,
  gitStatusMap: Record<string, GitStatusCode>,
): WorkspaceSnapshot {
  invalidateChangedPreloads(snapshot.root, snapshot.gitStatusMap, gitStatusMap);
  const flatFiles: WorkspaceEntry[] = [];
  const entries = collectFiles(snapshot.entries, gitStatusMap, flatFiles);
  return {
    ...snapshot,
    entries,
    flatFiles,
    gitStatusMap,
    treeItemsChanged: toChangedItems(snapshot.root, flatFiles, gitStatusMap),
    commandItems: flatFiles.map(toCommandItem),
  };
}

/** Whether two git status maps say the same. */
export function sameGitStatus(
  a: Record<string, GitStatusCode>,
  b: Record<string, GitStatusCode>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The disk stamp of the folders the tree shows (`mtimeMs`, or `-` when unreadable). */
export async function readFolderStamps(
  dirs: readonly string[],
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<string> {
  const stamps = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return `${dir}:${(await deps.stat(dir)).mtimeMs}`;
      } catch {
        return `${dir}:-`;
      }
    }),
  );
  return stamps.join("\n");
}

/** A path moved by a rename: `[from, to]`, absolute. */
export type Rename = readonly [string, string];

function childrenByFolder(
  dir: string,
  entries: WorkspaceEntry[],
  out: Map<string, WorkspaceEntry[]>,
): Map<string, WorkspaceEntry[]> {
  out.set(dir, entries);
  for (const entry of entries) {
    if (entry.isDirectory) childrenByFolder(entry.path, entry.children ?? [], out);
  }
  return out;
}

/** Detect 1-to-1 same-kind renames in a folder in O(K) time via `Set` membership. */
export function detectRenames(
  root: string,
  before: WorkspaceEntry[],
  after: WorkspaceEntry[],
): Rename[] {
  const old = childrenByFolder(root, before, new Map());
  const fresh = childrenByFolder(root, after, new Map());
  const renames: Rename[] = [];
  for (const [dir, oldChildren] of old) {
    const newChildren = fresh.get(dir);
    if (!newChildren) continue;
    const oldPaths = new Set(oldChildren.map((e) => e.path));
    const newPaths = new Set(newChildren.map((n) => n.path));
    const went = oldChildren.filter((e) => !newPaths.has(e.path));
    const came = newChildren.filter((n) => !oldPaths.has(n.path));
    if (went.length === 1 && came.length === 1 && went[0].isDirectory === came[0].isDirectory) {
      renames.push([went[0].path, came[0].path]);
    }
  }
  return renames;
}

/** `filePath` after `renames`: the path itself or anything under it moves. */
export function migratePath(filePath: string, renames: readonly Rename[]): string {
  for (const [from, to] of renames) {
    if (filePath === from) return to;
    if (filePath.startsWith(`${from}/`)) return to + filePath.slice(from.length);
  }
  return filePath;
}

/** `file` at `filePath`: its names follow, its text and state stay. */
export function relocateFile(file: LoadedFile, filePath: string, root: string): LoadedFile {
  return {
    ...file,
    path: filePath,
    name: path.basename(filePath),
    relPath: relativePath(root, filePath),
  };
}

/** Fetch lock-free git diff patch for a specific file (staged + unstaged vs HEAD, or unstaged). */
export async function getFileDiffPatch(
  filePath: string,
  root: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<string> {
  const cwd = execCwd(root || path.dirname(filePath));
  try {
    const headDiff = await deps.runGit(["--no-optional-locks", "diff", "HEAD", "--", filePath], cwd);
    if (headDiff.code === 0 && headDiff.stdout.trim().length > 0) return headDiff.stdout;
  } catch {
    // HEAD may not exist yet; fall through to unstaged diff.
  }
  try {
    const unstaged = await deps.runGit(["--no-optional-locks", "diff", "--", filePath], cwd);
    return unstaged.code === 0 ? unstaged.stdout : "";
  } catch {
    return "";
  }
}

function previewBlobUrl(
  filePath: string,
  classification: FileClassification,
  bytes: Uint8Array,
): string | null {
  if (classification.kind === "image") {
    return createBlobUrl(bytes, classification.mimeType);
  }
  if (classification.kind === "video" || classification.kind === "audio") {
    return filePath;
  }
  return null;
}

/**
 * Read preview bytes from an already-statted file (`0` extra `fs.stat`s).
 * Files `> MAX_EDITABLE_BYTES` spawn `python3` ONCE for `MAX_PREVIEW_HEAD_BYTES` (`256 KiB`)
 * and check the first `4 KiB` in memory for NUL bytes.
 */
async function readFileBytesFromDiskStat(
  filePath: string,
  disk: DiskStat,
  deps: WorkspaceIoDeps,
): Promise<{ bytes: Uint8Array; size: number; completeness: ReadCompleteness }> {
  const preKind = classifyFile(filePath).kind;
  if (VIEWER_SPECS[preKind].io === "stat") {
    return { bytes: new Uint8Array(0), size: disk.size, completeness: "full" };
  }
  if (disk.size <= MAX_EDITABLE_BYTES || preKind === "image") {
    const bytes = await deps.readFile(filePath);
    return { bytes, size: bytes.length, completeness: "full" };
  }
  const headCount = preKind === "binary" ? BINARY_HEAD_BYTES : MAX_PREVIEW_HEAD_BYTES;
  const head = await deps.readHead(filePath, headCount);
  const sample = head.subarray(0, BINARY_HEAD_BYTES);
  if (classifyFile(filePath, sample).kind === "binary") {
    return { bytes: sample, size: disk.size, completeness: "partial" };
  }
  return { bytes: head, size: disk.size, completeness: "partial" };
}

/** The current `mtimeMs:size` of `filePath` on disk, or null when it cannot be read. */
export async function readDiskStamp(
  filePath: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<string | null> {
  return (await statDisk(filePath, deps))?.stamp ?? null;
}

/** Whether the disk now holds other bytes than `stamp` describes; false when either is unknown. */
export function isBehindDisk(stamp: string | null, current: string | null): boolean {
  return stamp !== null && current !== null && current !== stamp;
}

/** Whether `file` is behind the disk: the file changed since this copy was read or saved. */
export async function hasChangedOnDisk(
  file: LoadedFile,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<boolean> {
  return isBehindDisk(file.diskStamp, await readDiskStamp(file.path, deps));
}

/** Read `file` from disk again (same mode), dropping its cached copy; null when unreadable. */
export async function reloadFromDisk(
  file: LoadedFile,
  root: string,
  knownStat?: DiskStat,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<LoadedFile | null> {
  preloadedFiles.delete(file.path);
  try {
    return await loadFile(file.path, root, file.mode, file.gitStatus, knownStat, deps);
  } catch {
    return null;
  }
}

/** Reload `file` when clean and changed on disk (single `statDisk` check + reuse). */
export async function reloadIfChangedOnDisk(
  file: LoadedFile,
  root: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<LoadedFile | null> {
  if (file.dirty) return null;
  const disk = await statDisk(file.path, deps);
  if (!disk || !isBehindDisk(file.diskStamp, disk.stamp)) return null;
  return reloadFromDisk(file, root, disk, deps);
}

function canCachePreloaded(file: LoadedFile): boolean {
  return VIEWER_SPECS[file.classification.kind].canPrewarm && file.size <= MAX_PRELOAD_BYTES;
}

function syncPreloadedRoot(root: string): void {
  if (!root) {
    preloadedRoot = "";
    preloadedFiles.clear();
    return;
  }
  if (preloadedRoot && preloadedRoot !== root) {
    preloadedFiles.clear();
  }
  preloadedRoot = root;
}

function isCrossRootMiss(root: string): boolean {
  return Boolean(root && preloadedRoot && root !== preloadedRoot);
}

function canOpenPreloadedInDiff(hit: LoadedFile): boolean {
  return hit.classification.kind === "diff" || Boolean(hit.diffPatch);
}

/** Return a preloaded clean LoadedFile synchronously if available in the warm LRU cache. */
export function getPreloadedFile(
  filePath: string,
  root: string,
  gitStatus?: GitStatusCode,
  openInDiff?: boolean,
): LoadedFile | null {
  if (isCrossRootMiss(root)) return null;
  const hit = preloadedFiles.get(filePath);
  if (!hit || (openInDiff && !canOpenPreloadedInDiff(hit))) return null;
  return {
    ...hit,
    relPath: relativePath(root, filePath),
    mode: openInDiff ? "diff" : hit.classification.defaultMode,
    gitStatus: gitStatus ?? hit.gitStatus,
  };
}

async function prewarmSingleEntry(
  entry: WorkspaceEntry,
  root: string,
  deps: WorkspaceIoDeps,
): Promise<void> {
  if (preloadedFiles.has(entry.path)) return;
  try {
    const disk = await statDisk(entry.path, deps);
    if (!disk || !disk.isFile || disk.size > MAX_PRELOAD_BYTES) return;
    const loaded = await loadFile(entry.path, root, undefined, entry.gitStatus, disk, deps);
    if (preloadedRoot === root && canCachePreloaded(loaded)) {
      preloadedFiles.set(entry.path, loaded);
    }
  } catch {
    // Ignore background preload errors.
  }
}

/** Prewarm small `code` and `markdown` files (`VIEWER_SPECS[kind].canPrewarm`) in a 32-entry LRU. */
export async function warmWorkspaceFiles(
  snapshot: WorkspaceSnapshot,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<void> {
  syncPreloadedRoot(snapshot.root);
  if (!snapshot.root) return;
  const candidates = snapshot.flatFiles
    .filter((entry) => VIEWER_SPECS[classifyFile(entry.path).kind].canPrewarm)
    .slice(0, MAX_PRELOAD_FILES);
  await Promise.all(candidates.map((entry) => prewarmSingleEntry(entry, snapshot.root, deps)));
}

async function resolveInitialDiffPatch(
  filePath: string,
  root: string,
  kind: FileClassification["kind"],
  mode: PreviewMode,
  text: string,
  deps: WorkspaceIoDeps,
): Promise<string> {
  if (kind === "diff") return text;
  if (mode === "diff") return getFileDiffPatch(filePath, root, deps);
  return "";
}

async function resolveQuickLookForKind(
  filePath: string,
  root: string,
  kind: FileClassification["kind"],
): Promise<string | null> {
  if (kind !== "quicklook") return null;
  return generateQuickLookUrl(
    filePath,
    execCwd(root || path.dirname(filePath)),
    path.join(aedCacheDir(), "ql"),
  );
}

async function requireDiskStat(
  filePath: string,
  knownStat: DiskStat | undefined,
  deps: WorkspaceIoDeps,
): Promise<DiskStat> {
  const disk = knownStat ?? (await statDisk(filePath, deps));
  if (disk) return disk;
  await deps.stat(filePath);
  throw new Error(`cannot stat ${filePath}`);
}

function resolveInitialMode(
  classification: FileClassification,
  preferredMode?: PreviewMode,
): PreviewMode {
  return preferredMode && allowsMode(classification, preferredMode)
    ? preferredMode
    : classification.defaultMode;
}

function cacheLoadedIfEligible(filePath: string, root: string, loaded: LoadedFile): void {
  if (!canCachePreloaded(loaded)) return;
  syncPreloadedRoot(root || preloadedRoot);
  preloadedFiles.set(filePath, loaded);
}

/** Read a file from disk for preview/editing using a single `statDisk` call. */
export async function loadFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
  knownStat?: DiskStat,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<LoadedFile> {
  const disk = await requireDiskStat(filePath, knownStat, deps);
  const { bytes, size, completeness } = await readFileBytesFromDiskStat(filePath, disk, deps);
  const classification = classifyFile(filePath, bytes.subarray(0, BINARY_HEAD_BYTES));
  const mode = resolveInitialMode(classification, preferredMode);
  const { text, bom, readOnly } = decodeFileText(classification, bytes, completeness);
  const kind = classification.kind;
  const loaded: LoadedFile = {
    path: filePath,
    relPath: relativePath(root, filePath),
    name: path.basename(filePath),
    size,
    classification,
    mode,
    gitStatus,
    text,
    savedText: text,
    dirty: false,
    blobUrl: previewBlobUrl(filePath, classification, bytes),
    quickLookUrl: await resolveQuickLookForKind(filePath, root, kind),
    dimensions: kind === "image" ? probeImageDimensions(bytes, text) : null,
    tableData: kind === "table" ? parseTableData(text, filePath, completeness === "partial") : null,
    hexDump: kind === "binary" ? formatHexDump(bytes, BINARY_HEAD_BYTES) : "",
    diffPatch: await resolveInitialDiffPatch(filePath, root, kind, mode, text, deps),
    diskStamp: disk.stamp,
    diskChanged: false,
    diskMissing: false,
    bom,
    readOnly,
    saveError: null,
  };
  cacheLoadedIfEligible(filePath, root, loaded);
  return loaded;
}

/** Load a file for a tab (`1` `statDisk` total), or its diff against HEAD when git-deleted and gone. */
export async function loadTabFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<LoadedFile> {
  const disk = await statDisk(filePath, deps);
  if (!disk && gitStatus === "D") {
    return loadDeletedFile(filePath, root, deps);
  }
  return loadFile(filePath, root, preferredMode, gitStatus, disk ?? undefined, deps);
}

async function loadDeletedFile(
  filePath: string,
  root: string,
  deps: WorkspaceIoDeps,
): Promise<LoadedFile> {
  const classification = classifyFile(filePath);
  const mode = allowsMode(classification, "diff") ? "diff" : classification.defaultMode;
  return {
    path: filePath,
    relPath: relativePath(root, filePath),
    name: path.basename(filePath),
    size: 0,
    classification,
    mode,
    gitStatus: "D",
    text: "",
    savedText: "",
    dirty: false,
    blobUrl: null,
    quickLookUrl: null,
    dimensions: null,
    tableData: null,
    hexDump: "",
    diffPatch: mode === "diff" ? await getFileDiffPatch(filePath, root, deps) : "",
    diskStamp: null,
    diskChanged: false,
    diskMissing: false,
    bom: false,
    readOnly: DELETED_FILE_NOTICE,
    saveError: null,
  };
}

/** Write `newText` for `file` (UTF-8, BOM kept) and recompute derived preview metadata. */
export async function saveFileText(
  file: LoadedFile,
  newText: string,
  root: string,
  deps: WorkspaceIoDeps = DEFAULT_IO,
): Promise<LoadedFile> {
  if (file.diskStamp !== null && (await statDisk(file.path, deps)) === null) {
    throw new Error(FILE_MISSING_REASON);
  }
  const bytes = encodeUtf8(newText, file.bom);
  await deps.writeFile(file.path, bytes);
  const kind = file.classification.kind;
  const isImage = kind === "image";
  const updated: LoadedFile = {
    ...file,
    size: bytes.length,
    text: newText,
    savedText: newText,
    dirty: false,
    tableData: kind === "table" ? parseTableData(newText, file.path) : file.tableData,
    blobUrl: isImage ? createBlobUrl(bytes, file.classification.mimeType) : file.blobUrl,
    dimensions: isImage ? probeImageDimensions(bytes, newText) : file.dimensions,
    diffPatch: kind === "diff" ? newText : "",
    relPath: relativePath(root, file.path),
    diskStamp: await readDiskStamp(file.path, deps),
    diskChanged: false,
    diskMissing: false,
    saveError: null,
  };
  if (canCachePreloaded(updated)) preloadedFiles.set(file.path, updated);
  else preloadedFiles.delete(file.path);
  return updated;
}

/** Ask for a path to save `file` at (macOS save panel via osascript); null when cancelled. */
export async function pickSavePath(file: LoadedFile): Promise<string | null> {
  const script = [
    "on run argv",
    'POSIX path of (choose file name with prompt "Save As" default name (item 1 of argv) default location (POSIX file (item 2 of argv)))',
    "end run",
  ];
  const args = script.flatMap((line) => ["-e", line]);
  const dir = path.dirname(file.path);
  try {
    const result = await process.run("osascript", [...args, file.name, dir], { cwd: execCwd(dir) });
    const picked = result.stdout.trim();
    return picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
}

/** Open macOS folder picker dialog via osascript and return selected folder path or null. */
export async function pickWorkspaceFolder(cwd: string): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Choose a workspace folder")';
  try {
    const result = await process.run("osascript", ["-e", script], { cwd: execCwd(cwd) });
    const picked = normalizeDirPath(result.stdout);
    return picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
}

/** Schedule `fn` on the next timer turn outside an effect's synchronous pass, cancelling on cleanup. */
export function deferOutOfEffect(fn: () => void): void {
  const id = setTimeout(fn, 0);
  cleanup(() => clearTimeout(id));
}

/** Memoize an async initializer; concurrent callers share one Promise, rejections reset for retry. */
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = fn().catch((err) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}

/** Adaptive idle backoff (`2000ms -> 5000ms -> 10000ms`), resetting to `baseMs` on `"changed"`. */
export function nextPollDelayMs(
  currentMs: number,
  baseMs: number,
  maxMs: number,
  outcome: "idle" | "changed",
): number {
  if (outcome === "changed") return baseMs;
  return Math.min(Math.max(baseMs, maxMs), Math.round(currentMs * 2.5));
}

export interface ActiveIntervalOptions {
  baseMs: number;
  maxMs?: number;
  lifecycle: Accessor<string>;
  enabled?: Accessor<boolean>;
  tick: () => Promise<boolean>;
  onResume?: () => void;
}

interface PollTracker {
  delayMs: number;
  pendingChange: boolean;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly runTick: () => Promise<void>;
}

function startActivePollLoop(tracker: PollTracker): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tracker.runTick().then(() => {
        const outcome = tracker.pendingChange ? "changed" : "idle";
        tracker.pendingChange = false;
        tracker.delayMs = nextPollDelayMs(tracker.delayMs, tracker.baseMs, tracker.maxMs, outcome);
        schedule();
      });
    }, tracker.delayMs);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * Active-window poller: pauses when `lifecycle() !== "active"` or `enabled() === false`,
 * runs immediately on focus resume, serializes via `serialize()`, and backs off when idle.
 */
export function watchActiveInterval(opts: ActiveIntervalOptions): () => Promise<void> {
  const maxMs = opts.maxMs ?? opts.baseMs * 5;
  const tracker: PollTracker = {
    delayMs: opts.baseMs,
    pendingChange: false,
    baseMs: opts.baseMs,
    maxMs,
    runTick: serialize(async () => {
      try {
        if (await opts.tick()) tracker.pendingChange = true;
      } catch {
        // Swallow transient poll errors so subsequent ticks keep running.
      }
    }),
  };
  let seenInactive = false;

  effect(() => {
    const active = opts.lifecycle() === "active";
    const enabled = opts.enabled ? opts.enabled() : true;
    if (!active) {
      seenInactive = true;
      return;
    }
    if (!enabled) return;
    if (seenInactive) {
      seenInactive = false;
      tracker.delayMs = opts.baseMs;
      deferOutOfEffect(() => {
        opts.onResume?.();
        void tracker.runTick();
      });
    }
    cleanup(startActivePollLoop(tracker));
  });

  return tracker.runTick;
}
