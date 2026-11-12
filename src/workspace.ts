import { Buffer } from "buffer";
import { host } from "nsh";
import type { CommandItem, TreeItem } from "nsh/base";
import type { Dirent } from "fs/promises";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
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
  formatHexDump,
  generateQuickLookUrl,
  parseTableData,
  probeImageDimensions,
} from "./classify";

export type GitStatusCode = "M" | "A" | "D" | "U" | "R";

export interface WorkspaceEntry {
  path: string; // absolute path
  relPath: string; // relative to workspace root
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
  entries: WorkspaceEntry[];
  flatFiles: WorkspaceEntry[];
  gitStatusMap: Record<string, GitStatusCode>;
  treeItemsAll: TreeItem[];
  treeItemsChanged: TreeItem[];
  commandItems: CommandItem[];
  /** Why the root itself cannot be listed (moved, deleted, unreadable); the tree is empty then. */
  rootNotice: string | null;
}

/** The snapshot of no workspace. */
export function emptySnapshot(): WorkspaceSnapshot {
  return {
    root: "",
    branch: "",
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
  /**
   * `mtimeMs:size` of the bytes this copy came from (null when unknown). Each
   * copy carries its own, so a copy kept over a newer read still knows it is
   * behind the disk. DESIGN.md「状态机清单」#3.
   */
  diskStamp: string | null;
  /** The disk has a newer version than this copy's unsaved edits: a conflict the user resolves. */
  diskChanged: boolean;
  /** The file this copy came from is gone (moved or deleted outside Aed); a save never recreates it. */
  diskMissing: boolean;
  /** The bytes started with a UTF-8 byte order mark; a save writes it back. */
  bom: boolean;
  /** Why this copy can never be saved (its bytes are not UTF-8), or null. */
  readOnly: string | null;
  /** What the last save failed with, naming the path; null after a good save. */
  saveError: string | null;
}

/** Directories and files the scanner never descends into or lists. */
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

/** Kinds whose bytes never decode to editable text (except SVG images). */
const OPAQUE_KINDS = new Set(["binary", "image", "video", "audio", "quicklook"]);

function isOpaqueFile(classification: FileClassification): boolean {
  if (classification.mimeType === "image/svg+xml") return false;
  return OPAQUE_KINDS.has(classification.kind);
}

/**
 * Whether a file of this kind can be shown in `mode`. Opaque files (images,
 * PDF, media, binary) have their preview only: a source or diff view of them
 * would be an empty editor whose save wipes the file.
 */
export function allowsMode(classification: FileClassification, mode: PreviewMode): boolean {
  return !isOpaqueFile(classification) || mode === classification.defaultMode;
}

/** Whether this copy may ever be written back: text Aed decoded without loss. */
export function canSaveFile(file: LoadedFile): boolean {
  return !isOpaqueFile(file.classification) && file.readOnly === null;
}

/** Shown above a file whose bytes are not UTF-8; such a copy is never saved. */
export const NOT_UTF8_NOTICE = "Not UTF-8 — opened read-only";

/**
 * Files above this size are never read whole (DESIGN.md「文件大小上限」): nsh's
 * `writeFile` takes at most 8 MiB, so a larger file could not be saved anyway.
 */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/** How much of a text file above `MAX_EDITABLE_BYTES` is shown, read-only. */
const LARGE_TEXT_HEAD_BYTES = 256 * 1024;
/** How much of a large binary file is read: what its hex dump shows. */
const BINARY_HEAD_BYTES = 4096;

/** Shown above a text file above `MAX_EDITABLE_BYTES`; such a copy is never saved. */
export const LARGE_FILE_NOTICE = "Larger than 8 MB — showing the first 256 KB, read-only";

/** Shown above a file git lists as deleted: its diff against HEAD. */
export const DELETED_FILE_NOTICE = "Deleted — showing what was removed";

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

/** The editable text of a file's bytes; `readOnly` says why it must never be saved. */
function decodeFileText(
  classification: FileClassification,
  bytes: Uint8Array,
  partial: boolean,
): { text: string; bom: boolean; readOnly: string | null } {
  if (isOpaqueFile(classification)) return { text: "", bom: false, readOnly: null };
  // The cut may split a character: decode leniently, never save.
  if (partial) return { text: new TextDecoder("utf-8").decode(bytes), bom: false, readOnly: LARGE_FILE_NOTICE };
  const decoded = decodeUtf8(bytes);
  if (decoded) return { ...decoded, readOnly: null };
  // Shown for reading only: the lossy text must never reach the disk.
  return { text: new TextDecoder("utf-8").decode(bytes), bom: false, readOnly: NOT_UTF8_NOTICE };
}

// DESIGN.md「术语与边界」
/** Aed's per-user cache directory; `scripts/aed_paths.h` computes the same path. */
export function aedCacheDir(): string {
  return path.join(os.homedir(), "Library", "Caches", "dev.byronwayne.aed");
}

/** A queue entry the native writers (`aed_paths.h`) publish; `.<seq>.tmp` files are still being written. */
const QUEUE_ENTRY = /^(\d+)\.path$/;
let queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queueLock.then(fn, fn);
  queueLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** A place in a file: `line` and `column` count from 1; 0 when the reference names none. */
export interface FileLocation {
  path: string;
  line: number;
  column: number;
}

const HASH_LINE = /#L(\d+)(?:C(\d+)|-L?\d+)?$/i;
const COLON_LINE = /^(.+?):(\d+)(?::(\d+))?$/;

/** `file://[localhost]/p%20q#L3` → `/p q` and its fragment `#L3`. */
function decodeFileUrl(url: string): { filePath: string; fragment: string } {
  let rest = url.slice("file://".length);
  if (rest.startsWith("localhost/")) rest = rest.slice("localhost".length);
  const hash = rest.indexOf("#");
  const fragment = hash >= 0 ? rest.slice(hash) : "";
  if (hash >= 0) rest = rest.slice(0, hash);
  try {
    return { filePath: decodeURIComponent(rest), fragment };
  } catch {
    return { filePath: rest, fragment };
  }
}

/** `p#L3C2` or `p#L3-L9` → `p` at that line (a bare `#L3` too, with an empty path). */
function splitHashLine(ref: string): FileLocation | null {
  const hash = HASH_LINE.exec(ref);
  if (!hash) return null;
  return { path: ref.slice(0, hash.index), line: Number(hash[1]), column: Number(hash[2] ?? 0) };
}

/** `p#L3C2`, `p#L3-L9`, `p:3:2` or `p:3` → `p` at that line; null without such a suffix. */
function splitLineSuffix(ref: string): FileLocation | null {
  const hash = splitHashLine(ref);
  if (hash?.path) return hash;
  const colon = COLON_LINE.exec(ref);
  return colon ? { path: colon[1], line: Number(colon[2]), column: Number(colon[3] ?? 0) } : null;
}

/**
 * What an external reference (a path, a `file://` URL, either with a line
 * suffix) may name, most literal first: the path exactly as written, then
 * the path with its line suffix taken off. A file URL's `#L3` is always a
 * fragment (`#` in a name is written `%23`).
 */
export function externalFileCandidates(raw: string): FileLocation[] {
  const clean = raw.trim();
  if (!clean) return [];
  if (!clean.startsWith("file://")) {
    const stripped = splitLineSuffix(clean);
    return [{ path: clean, line: 0, column: 0 }, ...(stripped ? [stripped] : [])];
  }
  const { filePath, fragment } = decodeFileUrl(clean);
  const anchored = splitHashLine(fragment);
  const literal = { path: filePath, line: anchored?.line ?? 0, column: anchored?.column ?? 0 };
  const stripped = splitLineSuffix(filePath);
  return [literal, ...(stripped ? [stripped] : [])];
}

/** The path an external reference names with any line suffix taken off (markdown links, image sources). */
export function normalizeExternalFilePath(raw: string): string {
  return externalFileCandidates(raw).at(-1)?.path ?? "";
}

/**
 * The file an external open means: the path as written when it exists (a
 * file may be named `notes:12`), else the path without its line suffix,
 * with that line. Null when neither exists.
 */
export async function resolveExternalFileReference(raw: string): Promise<FileLocation | null> {
  for (const candidate of externalFileCandidates(raw)) {
    if (await fs.exists(candidate.path)) return candidate;
  }
  return null;
}

/** `host.params[paramKey]`, else the first of `envNames` that is set, else "". */
function readHostOrEnvParam(paramKey: string, ...envNames: string[]): string {
  const fromHost = host?.params?.[paramKey];
  if (typeof fromHost === "string" && fromHost.length > 0) return fromHost;
  return envNames.map((name) => process.env[name]).find((v) => v && v.length > 0) ?? "";
}

/** The file reference this window was started to open (Finder, the CLI launcher), unresolved. */
export function getInitialOpenFile(): string | null {
  const raw = readHostOrEnvParam("openFile", "AED_OPEN_FILE", "NATIVE_EDITOR_OPEN_FILE").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * This process's own queue directory (`AED_OPEN_QUEUE`, set by the native
 * bridge from its pid), or null when unset or not `<cache>/open-<number>`.
 */
export function resolveFinderQueueDir(): string | null {
  const raw = readHostOrEnvParam("openQueue", "AED_OPEN_QUEUE");
  const name = path.basename(raw);
  const inCache = path.dirname(raw) === aedCacheDir();
  return inCache && /^open-\d+$/.test(name) ? raw : null;
}

/** Read and delete one queue entry; only a regular file counts (a symlink is removed, never followed). */
async function takeQueueEntry(entryPath: string): Promise<string> {
  try {
    const stat = await fs.lstat(entryPath);
    return stat.isFile() ? new TextDecoder().decode(await fs.readFile(entryPath)) : "";
  } catch {
    return "";
  } finally {
    await fs.unlink(entryPath).catch(() => undefined);
  }
}

/** Read and delete the references queued for this window, in the order they were queued. */
export async function consumeFinderOpenQueue(): Promise<string[]> {
  const dir = resolveFinderQueueDir();
  if (!dir) return [];
  return withQueueLock(async () => {
    let names: string[];
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return [];
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const entries = names
      .map((name) => QUEUE_ENTRY.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const refs: string[] = [];
    for (const [name] of entries) {
      const ref = await takeQueueEntry(path.join(dir, name));
      if (ref) refs.push(ref);
    }
    return refs;
  });
}

/** Resolve initial workspace root from host.params.workspaceRoot or process.env.AED_ROOT (or legacy NATIVE_EDITOR_ROOT); returns "" on clean launch or loose file launch so $HOME, /, or parent folders are never auto-scanned. */
export function getInitialWorkspaceRoot(): string {
  return readHostOrEnvParam(
    "workspaceRoot",
    "AED_ROOT",
    "NATIVE_EDITOR_ROOT"
  );
}

/** Check whether a path on disk is a directory. */
export async function isDirectoryPath(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function execCwd(cwd?: string): string {
  return cwd && cwd.length > 0 ? cwd : os.homedir();
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
  statusMap: Record<string, GitStatusCode>
): GitStatusCode | undefined {
  const rel = relativePath(root, filePath);
  return statusMap[rel] ?? statusMap[filePath];
}

/** Whether a directory entry is one of the ignored names or a hidden dot-folder. */
function isIgnored(name: string, isDirectory: boolean): boolean {
  if (IGNORED_NAMES.has(name)) return true;
  if (isDirectory && name.startsWith(".") && name !== ".github") return true;
  return false;
}

/** A folder's listed entries, and why some are missing (a notice), if any are. */
interface DirListing {
  entries: WorkspaceEntry[];
  notice: string | null;
}

/** Folders first, then files, each alphabetically. */
function compareDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Recursively list a directory in parallel across subdirectories. Ignored
 * names are dropped before the MAX_DIR_ENTRIES cut, so they never take a
 * place; a folder Aed cannot read, or did not descend into, says so.
 */
async function scanDirectory(root: string, dir: string, depth = 0): Promise<DirListing> {
  if (depth > MAX_SCAN_DEPTH) return { entries: [], notice: FOLDER_NOTICES.tooDeep };
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { entries: [], notice: FOLDER_NOTICES.unreadable };
  }
  const visible = dirents
    .filter((dirent) => !isIgnored(dirent.name, dirent.isDirectory()))
    .sort(compareDirents);
  const shown = visible.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(
    shown.map(async (dirent): Promise<WorkspaceEntry> => {
      const full = path.join(dir, dirent.name);
      const entry: WorkspaceEntry = {
        path: full,
        relPath: relativePath(root, full),
        name: dirent.name,
        isDirectory: dirent.isDirectory(),
      };
      if (!entry.isDirectory) return entry;
      const listing = await scanDirectory(root, full, depth + 1);
      entry.children = listing.entries;
      if (listing.notice) entry.notice = listing.notice;
      return entry;
    })
  );
  const omitted = visible.length - shown.length;
  return { entries, notice: omitted > 0 ? moreItemsNotice(omitted) : null };
}

/** Attach gitStatus to each entry and collect every file in display order. */
function collectFiles(
  entries: WorkspaceEntry[],
  gitStatusMap: Record<string, GitStatusCode>
): WorkspaceEntry[] {
  const files: WorkspaceEntry[] = [];
  for (const entry of entries) {
    entry.gitStatus = gitStatusMap[entry.relPath];
    if (entry.isDirectory) {
      files.push(...collectFiles(entry.children ?? [], gitStatusMap));
    } else {
      files.push(entry);
    }
  }
  return files;
}

/** Tree rows for `entries` of folder `dir`, ending with the folder's notice row (disabled), if any. */
function toTreeItems(dir: string, entries: WorkspaceEntry[], notice: string | null | undefined): TreeItem[] {
  const items = entries.map(toTreeItem);
  if (notice) items.push({ id: noticeRowId(dir), label: notice, disabled: true });
  return items;
}

/** A tree row for an entry, folders carrying their children. */
function toTreeItem(entry: WorkspaceEntry): TreeItem {
  const item: TreeItem = { id: entry.path, label: entry.name };
  if (entry.isDirectory) item.children = toTreeItems(entry.path, entry.children ?? [], entry.notice);
  return item;
}

/** The id of a folder's notice row: never a path on disk (NUL cannot be in a name). */
function noticeRowId(dir: string): string {
  return `${dir}/\u0000notice`;
}

/** A flat tree of the files git reports as changed, deleted ones (not on disk) last. */
function toChangedItems(
  root: string,
  flatFiles: WorkspaceEntry[],
  gitStatusMap: Record<string, GitStatusCode>
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

/** A quick-open row for a file. */
function toCommandItem(entry: WorkspaceEntry): CommandItem {
  return { id: entry.path, label: entry.relPath, keywords: [entry.name], group: "Files" };
}

/** Map one porcelain status pair to the single code the UI shows. */
function toGitStatus(code: string): GitStatusCode {
  if (code === "??") return "U";
  if (code[0] === "R" || code[1] === "R") return "R";
  if (code[0] === "A" || code[1] === "A") return "A";
  if (code[0] === "D" || code[1] === "D") return "D";
  return "M";
}

/** Parse `git status --porcelain=v1 -z -uall` into a relative-path status map. */
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
    if (code[0] === "R" || code[0] === "C") i += 1; // skip the source-path field
  }
  return map;
}

/** Run `git status --porcelain=v1 -z -uall`; an empty map outside a repository. */
export async function readGitStatus(root: string): Promise<Record<string, GitStatusCode>> {
  try {
    const result = await process.run(
      "git",
      ["status", "--porcelain=v1", "-z", "-uall"],
      { cwd: root },
    );
    return parseGitStatus(result.stdout);
  } catch {
    return {};
  }
}

/** The current branch name, or "" outside a repository. */
async function readGitBranch(root: string): Promise<string> {
  try {
    const result = await process.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

/** Scan workspace directory, git branch, and git status (-z). */
export async function scanWorkspace(root: string): Promise<WorkspaceSnapshot> {
  if (!root || root.trim().length === 0) return emptySnapshot();
  const [gitStatusMap, branch, listing] = await Promise.all([
    readGitStatus(root),
    readGitBranch(root),
    scanDirectory(root, root),
  ]);
  const unlisted = listing.notice === FOLDER_NOTICES.unreadable;
  const rootNotice = !unlisted
    ? null
    : (await isDirectoryPath(root))
      ? FOLDER_NOTICES.unreadable
      : FOLDER_NOTICES.rootMissing;
  const base: WorkspaceSnapshot = {
    ...emptySnapshot(),
    root,
    branch,
    entries: listing.entries,
    treeItemsAll: unlisted ? [] : toTreeItems(root, listing.entries, listing.notice),
    rootNotice,
  };
  return withGitStatus(base, gitStatusMap);
}

/** `snapshot` with a new git status: the badges, the Changed list and quick open follow it. */
export function withGitStatus(
  snapshot: WorkspaceSnapshot,
  gitStatusMap: Record<string, GitStatusCode>
): WorkspaceSnapshot {
  const flatFiles = collectFiles(snapshot.entries, gitStatusMap);
  return {
    ...snapshot,
    flatFiles,
    gitStatusMap,
    treeItemsChanged: toChangedItems(snapshot.root, flatFiles, gitStatusMap),
    commandItems: flatFiles.map(toCommandItem),
  };
}

/** Whether two git status maps say the same. */
export function sameGitStatus(
  a: Record<string, GitStatusCode>,
  b: Record<string, GitStatusCode>
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * The disk stamp of the folders the tree shows: each one's `mtimeMs` (a
 * child added, removed or renamed changes it), `-` when it cannot be read.
 */
export async function readFolderStamps(dirs: readonly string[]): Promise<string> {
  const stamps = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return `${dir}:${(await fs.stat(dir)).mtimeMs}`;
      } catch {
        return `${dir}:-`;
      }
    })
  );
  return stamps.join("\n");
}

/** A path moved by a rename: `[from, to]`, absolute. */
export type Rename = readonly [string, string];

function childrenByFolder(
  dir: string,
  entries: WorkspaceEntry[],
  out: Map<string, WorkspaceEntry[]>
): Map<string, WorkspaceEntry[]> {
  out.set(dir, entries);
  for (const entry of entries) {
    if (entry.isDirectory) childrenByFolder(entry.path, entry.children ?? [], out);
  }
  return out;
}

/**
 * The renames between two scans of `root`: in a folder both scans list, one
 * entry went and one of the same kind came. Anything else (several at once,
 * a move to another folder) is not guessed.
 */
export function detectRenames(
  root: string,
  before: WorkspaceEntry[],
  after: WorkspaceEntry[]
): Rename[] {
  const old = childrenByFolder(root, before, new Map());
  const fresh = childrenByFolder(root, after, new Map());
  const renames: Rename[] = [];
  for (const [dir, oldChildren] of old) {
    const newChildren = fresh.get(dir);
    if (!newChildren) continue;
    const went = oldChildren.filter((e) => !newChildren.some((n) => n.path === e.path));
    const came = newChildren.filter((n) => !oldChildren.some((e) => e.path === n.path));
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
  return { ...file, path: filePath, name: path.basename(filePath), relPath: relativePath(root, filePath) };
}

/** Fetch git diff patch for a specific file (staged + unstaged vs HEAD, or unstaged). */
export async function getFileDiffPatch(filePath: string, root: string): Promise<string> {
  const cwd = execCwd(root || path.dirname(filePath));
  try {
    const headDiff = await process.run("git", ["diff", "HEAD", "--", filePath], { cwd });
    if (headDiff.stdout.trim().length > 0) return headDiff.stdout;
  } catch {
    // HEAD may not exist yet; fall through to unstaged diff
  }
  try {
    const unstaged = await process.run("git", ["diff", "--", filePath], { cwd });
    return unstaged.stdout;
  } catch {
    return "";
  }
}

/** The preview source URL for an image, video, or audio file, or null for other kinds. */
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

const HEAD_SCRIPT =
  "import sys\nwith open(sys.argv[1], 'rb') as f: sys.stdout.write(f.read(int(sys.argv[2])).hex())";

/** The first `count` bytes of a file (fs/promises has no partial read; python3 is granted). */
async function readFileHead(filePath: string, count: number): Promise<Uint8Array> {
  const result = await process.run("python3", ["-c", HEAD_SCRIPT, filePath, String(count)], {
    cwd: execCwd(),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot read ${filePath}`);
  return new Uint8Array(Buffer.from(result.stdout.trim(), "hex"));
}

/**
 * The bytes a preview needs, and the file's size. Media and Quick Look files are
 * shown from their path (no bytes). A file above `MAX_EDITABLE_BYTES` is read in
 * part (`partial`): text its first `LARGE_TEXT_HEAD_BYTES`, binary its first
 * `BINARY_HEAD_BYTES`; images are read whole (their picture needs every byte).
 */
async function readFileBytesAndSize(
  filePath: string,
): Promise<{ bytes: Uint8Array; size: number; partial: boolean }> {
  const preKind = classifyFile(filePath).kind;
  const { size } = await fs.stat(filePath);
  if (preKind === "video" || preKind === "audio" || preKind === "quicklook") {
    return { bytes: new Uint8Array(0), size, partial: false };
  }
  if (size <= MAX_EDITABLE_BYTES || preKind === "image") {
    const bytes = await fs.readFile(filePath);
    return { bytes, size: bytes.length, partial: false };
  }
  const head = await readFileHead(filePath, BINARY_HEAD_BYTES);
  if (classifyFile(filePath, head).kind === "binary") return { bytes: head, size, partial: true };
  return { bytes: await readFileHead(filePath, LARGE_TEXT_HEAD_BYTES), size, partial: true };
}

const MAX_PRELOAD_FILES = 12;
const MAX_PRELOAD_BYTES = 262_144;
const preloadedFiles = new Map<string, LoadedFile>();
/** The current `mtimeMs:size` of `filePath` on disk, or null when it cannot be read. */
export async function readDiskStamp(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Whether the disk now holds other bytes than `stamp` describes; false when either is unknown. */
export function isBehindDisk(stamp: string | null, current: string | null): boolean {
  return stamp !== null && current !== null && current !== stamp;
}

/** Whether `file` is behind the disk: the file changed since this copy was read or saved. */
export async function hasChangedOnDisk(file: LoadedFile): Promise<boolean> {
  return isBehindDisk(file.diskStamp, await readDiskStamp(file.path));
}

/** Read `file` from disk again (same mode), dropping its cached copy; null when unreadable. */
export async function reloadFromDisk(
  file: LoadedFile,
  root: string,
): Promise<LoadedFile | null> {
  preloadedFiles.delete(file.path);
  try {
    return await loadFile(file.path, root, file.mode, file.gitStatus);
  } catch {
    return null;
  }
}

/**
 * Reload `file` when it changed on disk since Aed read or saved it. Returns
 * the fresh copy (same mode), or null when it is unchanged, dirty (the
 * user's edits win; no silent overwrite), or unreadable.
 */
export async function reloadIfChangedOnDisk(
  file: LoadedFile,
  root: string,
): Promise<LoadedFile | null> {
  if (file.dirty || !(await hasChangedOnDisk(file))) return null;
  return reloadFromDisk(file, root);
}

/** Return a preloaded clean LoadedFile synchronously if available in the warm cache. */
export function getPreloadedFile(
  filePath: string,
  root: string,
  gitStatus?: GitStatusCode,
  openInDiff?: boolean,
): LoadedFile | null {
  const hit = preloadedFiles.get(filePath);
  if (!hit) return null;
  if (openInDiff && hit.classification.kind !== "diff" && !hit.diffPatch) {
    return null;
  }
  const mode = openInDiff ? "diff" : hit.classification.defaultMode;
  return {
    ...hit,
    relPath: relativePath(root, filePath),
    mode,
    gitStatus: gitStatus ?? hit.gitStatus,
  };
}

/** Preload small workspace files in the background so clicking them in the tree renders in 0ms. */
export async function warmWorkspaceFiles(snapshot: WorkspaceSnapshot): Promise<void> {
  if (!snapshot.root) {
    preloadedFiles.clear();
    return;
  }
  const candidates = snapshot.flatFiles
    .filter((entry) => {
      const k = classifyFile(entry.path).kind;
      return k !== "video" && k !== "audio" && k !== "quicklook";
    })
    .slice(0, MAX_PRELOAD_FILES);

  await Promise.all(
    candidates.map(async (entry) => {
      if (preloadedFiles.has(entry.path)) return;
      try {
        const stat = await fs.stat(entry.path);
        if (stat.size > MAX_PRELOAD_BYTES) return;
        const loaded = await loadFile(entry.path, snapshot.root, undefined, entry.gitStatus);
        preloadedFiles.set(entry.path, loaded);
      } catch {
        // Ignore background preload errors.
      }
    })
  );
}

async function resolveInitialDiffPatch(
  filePath: string,
  root: string,
  kind: FileClassification["kind"],
  mode: PreviewMode,
  text: string,
): Promise<string> {
  if (kind === "diff") return text;
  if (mode === "diff") return getFileDiffPatch(filePath, root);
  return "";
}

/**
 * Read a file from disk for preview/editing (classifies, parses table/hex/diff/blob as needed) and
 * put it in the warm cache. The cache is read only through `getPreloadedFile` (App's 0ms path),
 * which `reloadIfChangedOnDisk` then revalidates against the disk stamp. The stamp is read before
 * the bytes: a write in between then shows as a change later, never as a change already seen.
 */
export async function loadFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
): Promise<LoadedFile> {
  const diskStamp = await readDiskStamp(filePath);
  const { bytes, size, partial } = await readFileBytesAndSize(filePath);
  const classification = classifyFile(filePath, bytes.slice(0, 4096));
  const mode =
    preferredMode && allowsMode(classification, preferredMode)
      ? preferredMode
      : classification.defaultMode;
  const { text, bom, readOnly } = decodeFileText(classification, bytes, partial);
  const tableData = classification.kind === "table" ? parseTableData(text, filePath) : null;
  const hexDump = classification.kind === "binary" ? formatHexDump(bytes, 4096) : "";
  const dimensions =
    classification.kind === "image" ? probeImageDimensions(bytes, text) : null;
  const quickLookUrl =
    classification.kind === "quicklook"
      ? await generateQuickLookUrl(
          filePath,
          execCwd(root || path.dirname(filePath)),
          path.join(aedCacheDir(), "ql")
        )
      : null;
  const diffPatch = await resolveInitialDiffPatch(
    filePath,
    root,
    classification.kind,
    mode,
    text
  );
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
    quickLookUrl,
    dimensions,
    tableData,
    hexDump,
    diffPatch,
    diskStamp,
    diskChanged: false,
    diskMissing: false,
    bom,
    readOnly,
    saveError: null,
  };
  if (size <= MAX_PRELOAD_BYTES && preloadedFiles.size < 32) {
    preloadedFiles.set(filePath, loaded);
  }
  return loaded;
}

/** A file for a new tab: `loadFile`, or for a file git lists as deleted and gone from disk, its diff. */
export async function loadTabFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
): Promise<LoadedFile> {
  if (gitStatus === "D" && (await readDiskStamp(filePath)) === null) {
    return loadDeletedFile(filePath, root);
  }
  return loadFile(filePath, root, preferredMode, gitStatus);
}

/** A file git lists as deleted, gone from disk: an empty, unsavable copy showing its diff. */
async function loadDeletedFile(filePath: string, root: string): Promise<LoadedFile> {
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
    diffPatch: mode === "diff" ? await getFileDiffPatch(filePath, root) : "",
    diskStamp: null,
    diskChanged: false,
    diskMissing: false,
    bom: false,
    readOnly: DELETED_FILE_NOTICE,
    saveError: null,
  };
}

/**
 * Write `newText` for `file` (UTF-8, its BOM kept) and return the saved copy.
 * What was derived from the old bytes follows the new ones: table rows, an
 * SVG's picture and size; a git patch is dropped so the next diff view fetches
 * it again. Throws what the write throws.
 */
export async function saveFileText(
  file: LoadedFile,
  newText: string,
  root: string,
): Promise<LoadedFile> {
  // A copy read from disk whose file is gone is never written back there (Save As instead).
  if (file.diskStamp !== null && (await readDiskStamp(file.path)) === null) {
    throw new Error(FILE_MISSING_REASON);
  }
  const bytes = encodeUtf8(newText, file.bom);
  await fs.writeFile(file.path, bytes);
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
    diskStamp: await readDiskStamp(file.path),
    diskChanged: false,
    diskMissing: false,
    saveError: null,
  };
  preloadedFiles.set(file.path, updated);
  return updated;
}

/** Why a save of a copy whose file is gone fails. */
export const FILE_MISSING_REASON = "the file was moved or deleted";

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
    const picked = result.stdout.trim().replace(/\/+$/, "");
    return picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
}
