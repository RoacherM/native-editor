import * as path from "path";
import { batch, computed, signal, type Accessor, type Signal } from "nsh";
import type {
  FileClassification,
  ImageDimensions,
  PreviewMode,
  TableData,
} from "./classify";
import type { FileStore } from "./saving";
import { nextActiveAfterClose } from "./session";
import {
  allowsMode,
  isBehindDisk,
  migratePath,
  relativePath,
  type DiskStat,
  type GitStatusCode,
  type LoadedFile,
  type Rename,
} from "./workspace";

export type Computed<T> = Accessor<T>;
export type DiskStatus = "synced" | "conflict" | "missing";

export interface TabLocation {
  line?: number;
  column?: number;
}

export interface TabFileMeta {
  path: string;
  relPath: string;
  name: string;
  classification: FileClassification;
  sizeBytes: number;
  hasBom: boolean;
  readOnly: string | null;
  gitStatus?: GitStatusCode;
  diffPatch: string;
  tableData: TableData | null;
  hexDump: string;
  dimensions: ImageDimensions | null;
  quickLookUrl: string | null;
}

export interface TabDocument {
  file: Signal<TabFileMeta>;
  text: Signal<string>;
  savedText: Signal<string>;
  dirty: Computed<boolean>;
  mode: Signal<PreviewMode>;
  diskStamp: Signal<string | null>;
  diskStatus: Signal<DiskStatus>;
  saveError: Signal<string | null>;
  reloadSeq: Signal<number>;
  blobUrl: Signal<string | null>;
}

export interface TabView {
  cursor: Signal<{ line: number; col: number }>;
  zoom: Signal<number>;
  contrastBg: Signal<boolean>;
  scrollY: Signal<number>;
  pendingReveal: Signal<{ line: number; column: number } | null>;
}

export interface TabEntry {
  readonly id: string;
  readonly path: Computed<string>;
  readonly doc: TabDocument;
  readonly view: TabView;
}

export interface TabStoreOptions {
  revokeUrl?: (url: string) => void;
}

export interface OpenTabOptions {
  activate?: boolean;
  location?: TabLocation | null;
}

export interface TabStore {
  readonly tabs: Accessor<TabEntry[]>;
  readonly openPaths: Computed<string[]>;
  readonly activePath: Signal<string | null>;
  readonly activeTab: Computed<TabEntry | undefined>;
  readonly dirtyPaths: Computed<string[]>;
  readonly hasDirtyTabs: Computed<boolean>;
  readonly fileStore: FileStore;
  getTab(filePath: string): TabEntry | undefined;
  openTab(loaded: LoadedFile, opts?: OpenTabOptions): TabEntry;
  activateTab(filePath: string): TabEntry | undefined;
  updateTabBufferText(filePath: string, nextText: string): void;
  setTabMode(filePath: string, mode: PreviewMode, diffPatch?: string): void;
  reloadTab(filePath: string, fresh: LoadedFile): boolean;
  keepTabEdits(filePath: string, diskStamp: string | null): void;
  applySavedTab(filePath: string, saved: LoadedFile): boolean;
  setTabSaveError(filePath: string, error: string | null): void;
  reconcileTabDisk(
    filePath: string,
    disk: DiskStat | null,
    reloadClean?: (tab: TabEntry, disk: DiskStat) => Promise<LoadedFile | null>,
  ): Promise<boolean>;
  syncGitStatus(root: string, gitStatusMap: Record<string, GitStatusCode>): void;
  migrateRenamedTabs(renames: readonly Rename[], root: string): void;
  closeTab(filePath: string): string | null;
  resetTabs(): void;
}

function revokeIfBlob(url: string | null | undefined, revoke: (u: string) => void): void {
  if (url && url.startsWith("blob:")) revoke(url);
}

function setTabBlobUrl(tab: TabEntry, nextUrl: string | null, revoke: (u: string) => void): void {
  const prevUrl = tab.doc.blobUrl();
  if (prevUrl === nextUrl) return;
  revokeIfBlob(prevUrl, revoke);
  tab.doc.blobUrl.set(nextUrl);
}

function metaFromLoaded(loaded: LoadedFile): TabFileMeta {
  return {
    path: loaded.path,
    relPath: loaded.relPath,
    name: loaded.name,
    classification: loaded.classification,
    sizeBytes: loaded.size,
    hasBom: loaded.bom,
    readOnly: loaded.readOnly,
    gitStatus: loaded.gitStatus,
    diffPatch: loaded.diffPatch,
    tableData: loaded.tableData,
    hexDump: loaded.hexDump,
    dimensions: loaded.dimensions ?? null,
    quickLookUrl: loaded.quickLookUrl,
  };
}

function initialDiskStatus(loaded: LoadedFile): DiskStatus {
  if (loaded.diskMissing) return "missing";
  return loaded.diskChanged ? "conflict" : "synced";
}

function createTabEntry(id: string, loaded: LoadedFile): TabEntry {
  const file = signal<TabFileMeta>(metaFromLoaded(loaded));
  const text = signal<string>(loaded.text);
  const savedText = signal<string>(loaded.savedText);
  const dirty = computed(() => text() !== savedText());
  return {
    id,
    path: computed(() => file().path),
    doc: {
      file,
      text,
      savedText,
      dirty,
      mode: signal<PreviewMode>(loaded.mode),
      diskStamp: signal<string | null>(loaded.diskStamp),
      diskStatus: signal<DiskStatus>(initialDiskStatus(loaded)),
      saveError: signal<string | null>(loaded.saveError),
      reloadSeq: signal<number>(0),
      blobUrl: signal<string | null>(loaded.blobUrl),
    },
    view: {
      cursor: signal({ line: 1, col: 1 }),
      zoom: signal(100),
      contrastBg: signal(false),
      scrollY: signal(0),
      pendingReveal: signal<{ line: number; column: number } | null>(null),
    },
  };
}

/** Snapshot a `TabEntry` as a `LoadedFile` value (`diskChanged` / `diskMissing` derived disjointly). */
export function toLoadedFileSnapshot(tab: TabEntry): LoadedFile {
  const meta = tab.doc.file();
  const status = tab.doc.diskStatus();
  return {
    path: meta.path,
    relPath: meta.relPath,
    name: meta.name,
    size: meta.sizeBytes,
    classification: meta.classification,
    mode: tab.doc.mode(),
    gitStatus: meta.gitStatus,
    text: tab.doc.text(),
    savedText: tab.doc.savedText(),
    dirty: tab.doc.dirty(),
    blobUrl: tab.doc.blobUrl(),
    quickLookUrl: meta.quickLookUrl,
    dimensions: meta.dimensions,
    tableData: meta.tableData,
    hexDump: meta.hexDump,
    diffPatch: meta.diffPatch,
    diskStamp: tab.doc.diskStamp(),
    diskChanged: status === "conflict",
    diskMissing: status === "missing",
    bom: meta.hasBom,
    readOnly: meta.readOnly,
    saveError: tab.doc.saveError(),
  };
}

/** Reactive `LoadedFile` accessor for components that read `Accessor<LoadedFile>`. */
export function tabLoadedFile(tab: TabEntry): Computed<LoadedFile> {
  return computed(() => toLoadedFileSnapshot(tab));
}

/** Reveal `loc` in `tab`: switches rich-preview files (`guide.md:25`) to `"source"` when allowed. */
export function applyTabLocation(tab: TabEntry, loc: TabLocation | null | undefined): void {
  if (!loc || !loc.line || loc.line <= 0) return;
  const { classification } = tab.doc.file();
  if (!allowsMode(classification, "source")) return;
  if (tab.doc.mode() !== "source") {
    tab.doc.mode.set("source");
  }
  tab.view.pendingReveal.set({ line: loc.line, column: loc.column ?? 0 });
}

interface InternalStore {
  nextSeq: number;
  byPath: Map<string, TabEntry>;
  tabs: Signal<TabEntry[]>;
  activePath: Signal<string | null>;
  revoke: (url: string) => void;
}

function reuseExistingTab(st: InternalStore, existing: TabEntry, loaded: LoadedFile): void {
  if (loaded.blobUrl !== existing.doc.blobUrl()) {
    revokeIfBlob(loaded.blobUrl, st.revoke);
  }
  batch(() => {
    const cur = existing.doc.file();
    const diffPatch = loaded.diffPatch || cur.diffPatch;
    if (cur.gitStatus !== loaded.gitStatus || cur.relPath !== loaded.relPath || cur.diffPatch !== diffPatch) {
      existing.doc.file.set({ ...cur, gitStatus: loaded.gitStatus, relPath: loaded.relPath, diffPatch });
    }
    if (allowsMode(cur.classification, loaded.mode) && existing.doc.mode() !== loaded.mode) {
      existing.doc.mode.set(loaded.mode);
    }
  });
}

function openTabInStore(st: InternalStore, loaded: LoadedFile, opts?: OpenTabOptions): TabEntry {
  let tab = st.byPath.get(loaded.path);
  if (tab) {
    reuseExistingTab(st, tab, loaded);
  } else {
    st.nextSeq += 1;
    tab = createTabEntry(`tab-${st.nextSeq}`, loaded);
    st.byPath.set(loaded.path, tab);
    st.tabs.update((list) => [...list, tab!]);
  }
  if (opts?.location) applyTabLocation(tab, opts.location);
  if (opts?.activate !== false) st.activePath.set(loaded.path);
  return tab;
}

function commitLoadedMetadata(
  tab: TabEntry,
  loaded: LoadedFile,
  revoke: (u: string) => void,
): void {
  tab.doc.file.set(metaFromLoaded(loaded));
  tab.doc.savedText.set(loaded.savedText);
  if (allowsMode(loaded.classification, loaded.mode)) tab.doc.mode.set(loaded.mode);
  tab.doc.diskStamp.set(loaded.diskStamp);
  tab.doc.diskStatus.set("synced");
  tab.doc.saveError.set(null);
  setTabBlobUrl(tab, loaded.blobUrl, revoke);
}

function reloadTabInStore(st: InternalStore, filePath: string, fresh: LoadedFile): boolean {
  const tab = st.byPath.get(filePath);
  if (!tab) {
    revokeIfBlob(fresh.blobUrl, st.revoke);
    return false;
  }
  batch(() => {
    commitLoadedMetadata(tab, fresh, st.revoke);
    tab.doc.text.set(fresh.text);
    tab.doc.reloadSeq.update((n) => n + 1);
  });
  return true;
}

function applySavedTabInStore(st: InternalStore, filePath: string, saved: LoadedFile): boolean {
  const tab = st.byPath.get(filePath);
  if (!tab) {
    revokeIfBlob(saved.blobUrl, st.revoke);
    return false;
  }
  batch(() => commitLoadedMetadata(tab, saved, st.revoke));
  return true;
}

function checkMissingOrCurrentDisk(tab: TabEntry, disk: DiskStat | null): boolean | "behind" {
  const stamp = tab.doc.diskStamp();
  if (!disk) {
    if (stamp === null || tab.doc.diskStatus() === "missing") return false;
    tab.doc.diskStatus.set("missing");
    return true;
  }
  if (!isBehindDisk(stamp, disk.stamp)) {
    if (tab.doc.diskStatus() !== "missing") return false;
    tab.doc.diskStatus.set("synced");
    return true;
  }
  return "behind";
}

async function reloadCleanBehindTab(
  st: InternalStore,
  filePath: string,
  tab: TabEntry,
  disk: DiskStat,
  reloadClean?: (tab: TabEntry, disk: DiskStat) => Promise<LoadedFile | null>,
): Promise<boolean> {
  if (!reloadClean) return false;
  const fresh = await reloadClean(tab, disk);
  const latest = st.byPath.get(filePath);
  if (!fresh || !latest || latest.doc.dirty()) {
    revokeIfBlob(fresh?.blobUrl, st.revoke);
    return false;
  }
  return reloadTabInStore(st, filePath, fresh);
}

async function reconcileTabDiskInStore(
  st: InternalStore,
  filePath: string,
  disk: DiskStat | null,
  reloadClean?: (tab: TabEntry, disk: DiskStat) => Promise<LoadedFile | null>,
): Promise<boolean> {
  const tab = st.byPath.get(filePath);
  if (!tab) return false;
  const stamp = tab.doc.diskStamp();
  const early = checkMissingOrCurrentDisk(tab, disk);
  if (early !== "behind") return early;
  if (!tab.doc.dirty()) {
    return reloadCleanBehindTab(st, filePath, tab, disk!, reloadClean);
  }
  if (tab.doc.diskStatus() === "conflict" || tab.doc.diskStamp() !== stamp) return false;
  tab.doc.diskStatus.set("conflict");
  return true;
}

function relocateSingleTab(tab: TabEntry, nextPath: string, root: string): void {
  const oldPath = tab.doc.file().path;
  tab.doc.file.update((f) => ({
    ...f,
    path: nextPath,
    name: path.basename(nextPath),
    relPath: relativePath(root, nextPath),
  }));
  if (tab.doc.blobUrl() === oldPath) tab.doc.blobUrl.set(nextPath);
  if (tab.doc.diskStatus() === "missing") tab.doc.diskStatus.set("synced");
}

function migrateRenamedInStore(st: InternalStore, renames: readonly Rename[], root: string): void {
  if (renames.length === 0) return;
  batch(() => {
    const nextMap = new Map<string, TabEntry>();
    for (const tab of st.tabs()) {
      const curPath = tab.doc.file().path;
      const nextPath = migratePath(curPath, renames);
      if (nextPath !== curPath) relocateSingleTab(tab, nextPath, root);
      nextMap.set(nextPath, tab);
    }
    st.byPath = nextMap;
    const curActive = st.activePath();
    if (curActive !== null) {
      const movedActive = migratePath(curActive, renames);
      if (movedActive !== curActive) st.activePath.set(movedActive);
    }
  });
}

function closeTabInStore(st: InternalStore, filePath: string): string | null {
  const tab = st.byPath.get(filePath);
  if (!tab) return st.activePath();
  const currentPaths = st.tabs().map((t) => t.doc.file().path);
  const nextActive = nextActiveAfterClose(currentPaths, filePath, st.activePath());
  batch(() => {
    setTabBlobUrl(tab, null, st.revoke);
    st.byPath.delete(filePath);
    st.tabs.update((list) => list.filter((t) => t !== tab));
    st.activePath.set(nextActive);
  });
  return nextActive;
}

function syncGitInStore(
  st: InternalStore,
  root: string,
  gitStatusMap: Record<string, GitStatusCode>,
): void {
  batch(() => {
    for (const tab of st.tabs()) {
      const cur = tab.doc.file();
      const rel = relativePath(root, cur.path);
      const nextGit = gitStatusMap[rel] ?? gitStatusMap[cur.path];
      if (cur.gitStatus !== nextGit || cur.relPath !== rel) {
        tab.doc.file.set({ ...cur, relPath: rel, gitStatus: nextGit });
      }
    }
  });
}

function buildFileStoreBridge(st: InternalStore): FileStore {
  return {
    get: (filePath) => {
      const tab = st.byPath.get(filePath);
      return tab ? toLoadedFileSnapshot(tab) : undefined;
    },
    set: (filePath, nextFile) => {
      const tab = st.byPath.get(filePath);
      if (!tab) {
        revokeIfBlob(nextFile.blobUrl, st.revoke);
        return;
      }
      if (nextFile.saveError !== null) {
        tab.doc.saveError.set(nextFile.saveError);
        return;
      }
      applySavedTabInStore(st, filePath, nextFile);
    },
  };
}

function activateTabInStore(st: InternalStore, filePath: string): TabEntry | undefined {
  const tab = st.byPath.get(filePath);
  if (tab) st.activePath.set(filePath);
  return tab;
}

function updateBufferInStore(st: InternalStore, filePath: string, nextText: string): void {
  st.byPath.get(filePath)?.doc.text.set(nextText);
}

function setTabModeInStore(
  st: InternalStore,
  filePath: string,
  mode: PreviewMode,
  diffPatch?: string,
): void {
  const tab = st.byPath.get(filePath);
  if (!tab || !allowsMode(tab.doc.file().classification, mode)) return;
  batch(() => {
    if (diffPatch !== undefined && diffPatch !== tab.doc.file().diffPatch) {
      tab.doc.file.update((f) => ({ ...f, diffPatch }));
    }
    tab.doc.mode.set(mode);
  });
}

function keepTabEditsInStore(st: InternalStore, filePath: string, diskStamp: string | null): void {
  const tab = st.byPath.get(filePath);
  if (!tab) return;
  batch(() => {
    tab.doc.diskStamp.set(diskStamp);
    tab.doc.diskStatus.set("synced");
  });
}

function resetTabsInStore(st: InternalStore): void {
  batch(() => {
    for (const tab of st.tabs()) setTabBlobUrl(tab, null, st.revoke);
    st.byPath.clear();
    st.tabs.set([]);
    st.activePath.set(null);
  });
}

function computeActiveTab(st: InternalStore): TabEntry | undefined {
  const p = st.activePath();
  if (!p) return undefined;
  void st.tabs();
  return st.byPath.get(p);
}

/** Create a per-tab document & view reactive session store. */
export function createTabStore(options?: TabStoreOptions): TabStore {
  const st: InternalStore = {
    nextSeq: 0,
    byPath: new Map(),
    tabs: signal<TabEntry[]>([]),
    activePath: signal<string | null>(null),
    revoke: options?.revokeUrl ?? ((url) => URL.revokeObjectURL(url)),
  };
  const openPaths = computed(() => st.tabs().map((t) => t.path()));
  const activeTab = computed(() => computeActiveTab(st));
  const dirtyPaths = computed(() =>
    st
      .tabs()
      .filter((t) => t.doc.dirty())
      .map((t) => t.path()),
  );

  return {
    tabs: st.tabs,
    openPaths,
    activePath: st.activePath,
    activeTab,
    dirtyPaths,
    hasDirtyTabs: computed(() => dirtyPaths().length > 0),
    fileStore: buildFileStoreBridge(st),
    getTab: (filePath) => st.byPath.get(filePath),
    openTab: (loaded, opts) => openTabInStore(st, loaded, opts),
    activateTab: (filePath) => activateTabInStore(st, filePath),
    updateTabBufferText: (filePath, nextText) => updateBufferInStore(st, filePath, nextText),
    setTabMode: (filePath, mode, diffPatch) => setTabModeInStore(st, filePath, mode, diffPatch),
    reloadTab: (filePath, fresh) => reloadTabInStore(st, filePath, fresh),
    keepTabEdits: (filePath, diskStamp) => keepTabEditsInStore(st, filePath, diskStamp),
    applySavedTab: (filePath, saved) => applySavedTabInStore(st, filePath, saved),
    setTabSaveError: (filePath, error) => {
      st.byPath.get(filePath)?.doc.saveError.set(error);
    },
    reconcileTabDisk: (filePath, disk, reloadClean) =>
      reconcileTabDiskInStore(st, filePath, disk, reloadClean),
    syncGitStatus: (root, gitStatusMap) => syncGitInStore(st, root, gitStatusMap),
    migrateRenamedTabs: (renames, root) => migrateRenamedInStore(st, renames, root),
    closeTab: (filePath) => closeTabInStore(st, filePath),
    resetTabs: () => resetTabsInStore(st),
  };
}
