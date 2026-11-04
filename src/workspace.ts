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

/** Resolve initial workspace root from host.params.workspaceRoot, process.env.NATIVE_EDITOR_ROOT, process.env.PWD, or os.homedir(). */
export function getInitialWorkspaceRoot(): string {
  const fromHost = host?.params?.workspaceRoot;
  if (typeof fromHost === "string" && fromHost.length > 0) return fromHost;
  const fromEnv = process.env.NATIVE_EDITOR_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const pwd = process.env.PWD;
  if (pwd && pwd.length > 0) return pwd;
  return os.homedir();
}

/** The path of `full` relative to `root` (both absolute). */
export function relativePath(root: string, full: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const prefix = `${cleanRoot}/`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
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

/** Whether a directory entry is one of the ignored names. */
function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

/** Folders first, then files, each alphabetically. */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Recursively list a directory, propagating git status to every entry. */
async function scanDirectory(
  root: string,
  dir: string,
  gitStatusMap: Record<string, GitStatusCode>,
  depth = 0,
): Promise<WorkspaceEntry[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_DIR_ENTRIES)) {
    if (isIgnored(dirent.name)) continue;
    const full = path.join(dir, dirent.name);
    const relPath = relativePath(root, full);
    const isDirectory = dirent.isDirectory();
    const entry: WorkspaceEntry = {
      path: full,
      relPath,
      name: dirent.name,
      isDirectory,
      gitStatus: gitStatusMap[relPath],
    };
    if (isDirectory) entry.children = await scanDirectory(root, full, gitStatusMap, depth + 1);
    entries.push(entry);
  }
  return sortEntries(entries);
}

/** Every file in the tree, depth first, in display order. */
function collectFiles(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const files: WorkspaceEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) files.push(...collectFiles(entry.children ?? []));
    else files.push(entry);
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
  const gitStatusMap = await readGitStatus(root);
  const branch = await readGitBranch(root);
  const entries = await scanDirectory(root, root, gitStatusMap);
  const flatFiles = collectFiles(entries);
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
  try {
    const headDiff = await process.run("git", ["diff", "HEAD", "--", filePath], { cwd: root });
    if (headDiff.stdout.trim().length > 0) return headDiff.stdout;
  } catch {
    // HEAD may not exist yet; fall through to unstaged diff
  }
  try {
    const unstaged = await process.run("git", ["diff", "--", filePath], { cwd: root });
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

/** Load a file for preview/editing (reads bytes, classifies, parses table/hex/diff/blob as needed). */
export async function loadFile(
  filePath: string,
  root: string,
  preferredMode?: PreviewMode,
  gitStatus?: GitStatusCode,
): Promise<LoadedFile> {
  const { bytes, size } = await readFileBytesAndSize(filePath);
  const classification = classifyFile(filePath, bytes.slice(0, 4096));
  const mode = preferredMode ?? classification.defaultMode;
  const text = isOpaqueFile(classification) ? "" : decodeText(bytes);
  const tableData = classification.kind === "table" ? parseTableData(text, filePath) : null;
  const hexDump = classification.kind === "binary" ? formatHexDump(bytes, 4096) : "";
  const dimensions =
    classification.kind === "image" ? probeImageDimensions(bytes, text) : null;
  const quickLookUrl =
    classification.kind === "quicklook" ? await generateQuickLookUrl(filePath, root) : null;
  const diffPatch =
    classification.kind === "diff"
      ? text
      : mode === "diff"
        ? await getFileDiffPatch(filePath, root)
        : "";
  return {
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
  return { ...file, text: newText, savedText: newText, dirty: false, tableData, relPath: relativePath(root, file.path) };
}

/** Open macOS folder picker dialog via osascript and return selected folder path or null. */
export async function pickWorkspaceFolder(cwd: string): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Choose a workspace folder")';
  try {
    const result = await process.run("osascript", ["-e", script], { cwd });
    const picked = result.stdout.trim().replace(/\/+$/, "");
    return picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
}

/** Open file in macOS default application (`open <path>`). */
export async function openInDefaultApp(filePath: string, cwd: string): Promise<void> {
  await process.run("open", [filePath], { cwd });
}

/** Reveal file in macOS Finder (`open -R <path>`). */
export async function revealInFinder(filePath: string, cwd: string): Promise<void> {
  await process.run("open", ["-R", filePath], { cwd });
}

/** Open macOS Quick Look modal preview (`qlmanage -p <path>`). */
export function openQuickLookModal(filePath: string, cwd: string): void {
  try {
    process.spawn("qlmanage", ["-p", filePath], { cwd });
  } catch {
    // Ignore if qlmanage is unavailable
  }
}
