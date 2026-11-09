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

// DESIGN.md「术语与边界」
const FINDER_OPEN_QUEUE_PATH = "/tmp/aed-open.queue";
let queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queueLock.then(fn, fn);
  queueLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** Normalize an external file reference (strips `file://`, URL encoding, `#L<line>`, and `:line(:col)` suffixes). */
export function normalizeExternalFilePath(raw: string): string {
  let clean = raw.trim();
  if (!clean) return "";
  const isFileUri = clean.startsWith("file://");
  if (isFileUri) {
    const hashIdx = clean.indexOf("#");
    if (hashIdx > 7) {
      clean = clean.slice(0, hashIdx);
    }
    try {
      clean = decodeURIComponent(clean.slice(7));
    } catch {
      clean = clean.slice(7);
    }
  } else {
    clean = clean.replace(/#L\d+(?:C\d+|-L?\d+)?$/i, "");
  }
  const lineColMatch = clean.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (lineColMatch) {
    clean = lineColMatch[1];
  }
  return clean;
}

function readHostOrEnvParam(
  paramKey: string,
  primaryEnv: string,
  legacyEnv: string
): string {
  const fromHost = host?.params?.[paramKey];
  if (typeof fromHost === "string" && fromHost.length > 0) return fromHost;
  const fromEnv = process.env[primaryEnv] || process.env[legacyEnv];
  return fromEnv && fromEnv.length > 0 ? fromEnv : "";
}

/** Resolve initial file opened from Finder or environment. */
export function getInitialOpenFile(): string | null {
  const resolved = normalizeExternalFilePath(
    readHostOrEnvParam(
      "openFile",
      "AED_OPEN_FILE",
      "NATIVE_EDITOR_OPEN_FILE"
    )
  );
  return resolved.length > 0 ? resolved : null;
}

/** Read and clear any file paths queued by the macOS Finder open-file bridge. */
export async function consumeFinderOpenQueue(): Promise<string[]> {
  return withQueueLock(async () => {
    try {
      const bytes = await fs.readFile(FINDER_OPEN_QUEUE_PATH);
      if (bytes.length === 0) return [];
      try {
        await fs.writeFile(FINDER_OPEN_QUEUE_PATH, "");
      } catch {
        // Continue even if truncating queue fails.
      }
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return raw
        .split(/\r?\n/)
        .map((line) => normalizeExternalFilePath(line))
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
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

/** Folders first, then files, each alphabetically. */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Recursively list a directory in parallel across subdirectories. */
async function scanDirectory(
  root: string,
  dir: string,
  depth = 0,
): Promise<WorkspaceEntry[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const visible = dirents
    .slice(0, MAX_DIR_ENTRIES)
    .filter((dirent) => !isIgnored(dirent.name, dirent.isDirectory()));
  const entries = await Promise.all(
    visible.map(async (dirent): Promise<WorkspaceEntry> => {
      const isDirectory = dirent.isDirectory();
      const full = path.join(dir, dirent.name);
      const relPath = relativePath(root, full);
      const children = isDirectory
        ? await scanDirectory(root, full, depth + 1)
        : undefined;
      return {
        path: full,
        relPath,
        name: dirent.name,
        isDirectory,
        children,
      };
    })
  );
  return sortEntries(entries);
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

/** A tree row for an entry, folders carrying their children. */
function toTreeItem(entry: WorkspaceEntry): TreeItem {
  const item: TreeItem = { id: entry.path, label: entry.name };
  if (entry.isDirectory) item.children = (entry.children ?? []).map(toTreeItem);
  return item;
}

/** A flat tree of the files git reports as changed. */
function toChangedItems(flatFiles: WorkspaceEntry[]): TreeItem[] {
  return flatFiles
    .filter((entry) => entry.gitStatus !== undefined)
    .map((entry) => ({ id: entry.path, label: entry.relPath }));
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
async function readGitStatus(root: string): Promise<Record<string, GitStatusCode>> {
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
  if (!root || root.trim().length === 0) {
    return {
      root: "",
      branch: "",
      entries: [],
      flatFiles: [],
      gitStatusMap: {},
      treeItemsAll: [],
      treeItemsChanged: [],
      commandItems: [],
    };
  }
  const [gitStatusMap, branch, entries] = await Promise.all([
    readGitStatus(root),
    readGitBranch(root),
    scanDirectory(root, root),
  ]);
  const flatFiles = collectFiles(entries, gitStatusMap);
  return {
    root,
    branch,
    entries,
    flatFiles,
    gitStatusMap,
    treeItemsAll: entries.map(toTreeItem),
    treeItemsChanged: toChangedItems(flatFiles),
    commandItems: flatFiles.map(toCommandItem),
  };
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

/** Decode bytes as UTF-8, replacing invalid sequences rather than throwing. */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
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

async function readFileBytesAndSize(
  filePath: string,
): Promise<{ bytes: Uint8Array; size: number }> {
  const preKind = classifyFile(filePath).kind;
  if (preKind === "video" || preKind === "audio") {
    try {
      const stat = await fs.stat(filePath);
      return { bytes: new Uint8Array(0), size: stat.size };
    } catch {
      return { bytes: new Uint8Array(0), size: 0 };
    }
  }
  const bytes = await fs.readFile(filePath);
  return { bytes, size: bytes.length };
}

const MAX_PRELOAD_FILES = 12;
const MAX_PRELOAD_BYTES = 262_144;
const preloadedFiles = new Map<string, LoadedFile>();

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

/** Load a file for preview/editing (reads bytes, classifies, parses table/hex/diff/blob as needed). */
export async function loadFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
): Promise<LoadedFile> {
  const preloaded = getPreloadedFile(filePath, root, gitStatus, preferredMode === "diff");
  if (preloaded) {
    return preferredMode ? { ...preloaded, mode: preferredMode } : preloaded;
  }
  const { bytes, size } = await readFileBytesAndSize(filePath);
  const classification = classifyFile(filePath, bytes.slice(0, 4096));
  const mode = preferredMode ?? classification.defaultMode;
  const text = isOpaqueFile(classification) ? "" : decodeText(bytes);
  const tableData = classification.kind === "table" ? parseTableData(text, filePath) : null;
  const hexDump = classification.kind === "binary" ? formatHexDump(bytes, 4096) : "";
  const dimensions =
    classification.kind === "image" ? probeImageDimensions(bytes, text) : null;
  const quickLookUrl =
    classification.kind === "quicklook"
      ? await generateQuickLookUrl(filePath, execCwd(root || path.dirname(filePath)))
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
  };
  if (size <= MAX_PRELOAD_BYTES && preloadedFiles.size < 32) {
    preloadedFiles.set(filePath, loaded);
  }
  return loaded;
}

/** Save text content to disk and return updated LoadedFile state. */
export async function saveFileText(
  file: LoadedFile,
  newText: string,
  root: string,
): Promise<LoadedFile> {
  await fs.writeFile(file.path, newText);
  const tableData =
    file.classification.kind === "table" ? parseTableData(newText, file.path) : file.tableData;
  const updated: LoadedFile = {
    ...file,
    text: newText,
    savedText: newText,
    dirty: false,
    tableData,
    relPath: relativePath(root, file.path),
  };
  preloadedFiles.set(file.path, updated);
  return updated;
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
