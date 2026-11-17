import * as os from "os";
import * as path from "path";
import process from "process";
import {
  cleanup,
  computed,
  effect,
  host,
  LayoutAnimation,
  lifecycle,
  reduceMotion,
  setColorScheme,
  signal,
  Storage,
  untracked,
  type Accessor,
  type Signal,
} from "nsh";
import type { CommandItem, TreeItem } from "nsh/base";
import { isAvailable as desktopAvailable, Window } from "nsh/desktop";
import { VIEWER_SPECS, type PreviewMode } from "./classify";
import { buildQuickOpenItems, OPEN_FOLDER_CMD_ID, type AppActions } from "./commands";
import { formatMediaMeta, getActiveView } from "./PreviewPane";
import { describeFailure, saveInStore, type SaveOutcome } from "./saving";
import {
  canToggleSidebar,
  decideGuard,
  deriveEditorSurface,
  deriveWindowMode,
  externalOpenKeepsTree,
  planWorkspaceIntent,
  runApprovedQuit,
  serialize,
  type EditorSurface,
  type ExternalOrigin,
  type GuardedAction,
  type UnsavedGuard as PendingUnsavedGuard,
  type WindowMode,
} from "./session";
import {
  createTabStore,
  toLoadedFileSnapshot,
  type TabEntry,
  type TabLocation,
  type TabStore,
} from "./tabs";
import { discoverTerminalEnvironment, type ShellProfile } from "./TerminalPane";
import {
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  getThemeById,
  syncThemeTokens,
  type EditorTheme,
} from "./themes";
import type { SegmentedItem } from "./ui";
import {
  allowsMode,
  canSaveFile,
  consumeFinderOpenQueue,
  deferOutOfEffect,
  detectRenames,
  emptySnapshot,
  getFileDiffPatch,
  getInitialOpenFile,
  getInitialWorkspaceRoot,
  getPreloadedFile,
  loadTabFile,
  lookupGitStatus,
  migratePath,
  normalizeExternalFilePath,
  pickSavePath,
  pickWorkspaceFolder,
  readDiskStamp,
  readFolderStamps,
  readGitStatus,
  reloadFromDisk,
  resolveExternalFileReference,
  resolveFinderQueueDir,
  sameGitStatus,
  saveFileText,
  scanWorkspace,
  shortenHomePath,
  statDisk,
  syncWindowStateFile,
  warmWorkspaceFiles,
  watchActiveInterval,
  withGitStatus,
  type FileLocation,
  type LoadedFile,
  type Rename,
  type WorkspaceSnapshot,
} from "./workspace";

const DEFAULT_FONT_FAMILY = "JetBrainsMono Nerd Font Mono";
const DEFAULT_FONT_SIZE = 14;
const DISK_CHECK_MS = 1500;
const WORKSPACE_POLL_MS = 2000;
const WORKSPACE_POLL_MAX_MS = 10000;

export interface OpenFileRequest {
  openInDiff?: boolean;
  location?: TabLocation | null;
}

interface PreferenceSignals {
  fontFamily: Signal<string>;
  fontSize: Signal<number>;
  themeId: Signal<string>;
  defaultShell: Signal<string>;
  availableShells: Signal<ShellProfile[]>;
}

interface SessionCtx {
  workspaceRoot: Signal<string>;
  recentWorkspaces: Signal<string[]>;
  snapshot: Signal<WorkspaceSnapshot>;
  filterMode: Signal<"all" | "changed">;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  tabs: TabStore;
  sidebarOpen: Signal<boolean>;
  sidebarWidth: Signal<number>;
  terminalOpen: Signal<boolean>;
  terminalHeight: Signal<number>;
  commandOpen: Signal<boolean>;
  commandMode: Signal<"files" | "commands">;
  prefs: PreferenceSignals;
  fontDialogOpen: Signal<boolean>;
  pendingUnsaved: Signal<PendingUnsavedGuard | null>;
  openError: Signal<string | null>;
  scanGen: { value: number };
  rememberWorkspace: (folderPath: string) => void;
}

function recordRecentWorkspace(recentWorkspaces: Signal<string[]>, folderPath: string): void {
  if (!folderPath || folderPath === "/") return;
  const next = [folderPath, ...recentWorkspaces().filter((w) => w !== folderPath)].slice(0, 5);
  recentWorkspaces.set(next);
  Storage.setItem("aed.recentWorkspaces", JSON.stringify(next));
}

function parseRecentWorkspaces(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  } catch {
    return [];
  }
}

function resolveSavedFontSize(savedSize: string | null, ghosttySize?: number): number | null {
  const parsed = savedSize ? Number.parseInt(savedSize, 10) : Number.NaN;
  if (!Number.isNaN(parsed) && parsed >= 9 && parsed <= 28) return parsed;
  return ghosttySize ? Math.round(ghosttySize) : null;
}

async function getStorageWithFallback(name: string): Promise<string | null> {
  const primary = await Storage.getItem(`aed.${name}`);
  return primary !== null ? primary : Storage.getItem(`native-editor.${name}`);
}

function applySavedThemeAndFont(
  prefs: PreferenceSignals,
  savedFamily: string | null,
  savedSize: string | null,
  savedTheme: string | null,
  ghostty: { fontFamily?: string; fontSize?: number; theme?: string },
): void {
  const family = savedFamily || ghostty.fontFamily;
  if (family) prefs.fontFamily.set(family);
  const size = resolveSavedFontSize(savedSize, ghostty.fontSize);
  if (size) prefs.fontSize.set(size);
  const resolvedTheme = getThemeById(savedTheme || ghostty.theme || DEFAULT_THEME_ID);
  prefs.themeId.set(resolvedTheme.id);
}

async function initUserPreferences(prefs: PreferenceSignals): Promise<void> {
  const [savedFamily, savedSize, savedTheme, savedShell] = await Promise.all([
    getStorageWithFallback("fontFamily"),
    getStorageWithFallback("fontSize"),
    getStorageWithFallback("theme"),
    getStorageWithFallback("shell"),
  ]);
  applySavedThemeAndFont(prefs, savedFamily, savedSize, savedTheme, {});
  if (savedShell) prefs.defaultShell.set(savedShell);

  const env = await discoverTerminalEnvironment();
  applySavedThemeAndFont(prefs, savedFamily, savedSize, savedTheme, env.ghostty);
  if (env.shells.length > 0) prefs.availableShells.set(env.shells);
  const shell = savedShell || env.shells[0]?.path;
  if (shell) prefs.defaultShell.set(shell);
}

function createQuitController(
  guard: (action: GuardedAction, dirtyPaths: string[], onProceed: () => void) => void,
  dirtyPaths: () => string[],
): { quit: () => void; edited: Accessor<boolean> } {
  const approved = signal(false);
  const exit = () => runApprovedQuit((v) => approved.set(v), () => process.exit(0));
  return {
    quit: () => (approved() ? exit() : guard("quit", dirtyPaths(), exit)),
    edited: computed(() => !approved() && dirtyPaths().length > 0),
  };
}

function modeLabel(mode: PreviewMode, rawLabel: string): string {
  if (mode === "preview") return "Preview";
  return mode === "diff" ? "Diff" : rawLabel;
}

/** Compute capability-driven `[Preview | Code | Diff]` pills for `tab` via `VIEWER_SPECS`. */
export function computeTabModeItems(tab: TabEntry | undefined): SegmentedItem<PreviewMode>[] {
  if (!tab) return [];
  const meta = tab.doc.file();
  const spec = VIEWER_SPECS[meta.classification.kind];
  const hasDiff = Boolean(meta.gitStatus || meta.diffPatch || tab.doc.dirty());
  const modes = spec.modes({
    mimeType: meta.classification.mimeType,
    editable: canSaveFile({ classification: meta.classification, readOnly: meta.readOnly }),
    hasDiff,
    currentMode: tab.doc.mode(),
  });
  if (modes.length <= 1) return [];
  return modes.map((m) => ({
    value: m,
    label: modeLabel(m, spec.rawModeLabel),
    testID: `mode-${m}`,
  }));
}

function animatePanelToggle(): void {
  if (!reduceMotion()) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }
}

function applyTreeRenames(ctx: SessionCtx, renames: readonly Rename[], root: string): void {
  if (renames.length === 0) return;
  ctx.tabs.migrateRenamedTabs(renames, root);
  const curSel = ctx.selectedPath();
  if (curSel !== null) ctx.selectedPath.set(migratePath(curSel, renames));
  ctx.expandedIds.set(ctx.expandedIds().map((id) => migratePath(id, renames)));
}

async function refreshWorkspace(ctx: SessionCtx): Promise<void> {
  ctx.scanGen.value += 1;
  const generation = ctx.scanGen.value;
  const root = ctx.workspaceRoot();
  const scanned = await scanWorkspace(root);
  if (generation !== ctx.scanGen.value || root !== ctx.workspaceRoot()) return;
  const prev = ctx.snapshot();
  if (prev.root === scanned.root) {
    applyTreeRenames(ctx, detectRenames(scanned.root, prev.entries, scanned.entries), scanned.root);
  }
  ctx.tabs.syncGitStatus(scanned.root, scanned.gitStatusMap);
  ctx.snapshot.set(scanned);
  void warmWorkspaceFiles(scanned);
}

function resetWorkspaceState(ctx: SessionCtx, nextRoot: string): void {
  ctx.openError.set(null);
  ctx.workspaceRoot.set(nextRoot);
  ctx.tabs.resetTabs();
  ctx.expandedIds.set([]);
  ctx.selectedPath.set(null);
  ctx.filterMode.set("all");
  if (nextRoot.length > 0) ctx.sidebarOpen.set(true);
}

function withUnsavedGuard(
  ctx: SessionCtx,
  action: GuardedAction,
  dirtyPaths: string[],
  onProceed: () => void,
): void {
  const decision = decideGuard(ctx.pendingUnsaved(), dirtyPaths);
  if (decision === "run") onProceed();
  else if (decision === "confirm") ctx.pendingUnsaved.set({ action, dirtyPaths, onProceed });
}

function switchToWorkspace(ctx: SessionCtx, folderPath: string): void {
  const plan = planWorkspaceIntent(ctx.workspaceRoot(), ctx.tabs.tabs().length, {
    kind: "open",
    root: folderPath,
  });
  if (plan.action === "refresh") void refreshWorkspace(ctx);
  if (plan.action !== "reset") return;
  withUnsavedGuard(ctx, "switch-folder", ctx.tabs.dirtyPaths(), () => {
    resetWorkspaceState(ctx, plan.nextRoot);
    ctx.rememberWorkspace(plan.nextRoot);
    void refreshWorkspace(ctx);
  });
}

function closeWorkspace(ctx: SessionCtx): void {
  const plan = planWorkspaceIntent(ctx.workspaceRoot(), ctx.tabs.tabs().length, { kind: "close" });
  if (plan.action !== "reset") return;
  withUnsavedGuard(ctx, "close-folder", ctx.tabs.dirtyPaths(), () => {
    resetWorkspaceState(ctx, "");
    void refreshWorkspace(ctx);
  });
}

function clearWorkspaceTree(ctx: SessionCtx): void {
  if (ctx.workspaceRoot().length === 0) return;
  ctx.workspaceRoot.set("");
  ctx.snapshot.set(emptySnapshot());
  ctx.expandedIds.set([]);
}

async function setFileModeInSession(
  ctx: SessionCtx,
  filePath: string,
  mode: PreviewMode,
): Promise<void> {
  const tab = ctx.tabs.getTab(filePath);
  if (!tab) return;
  const meta = tab.doc.file();
  if (!allowsMode(meta.classification, mode)) return;
  const needPatch = mode === "diff" && !meta.diffPatch && meta.classification.kind !== "diff";
  const diffPatch = needPatch ? await getFileDiffPatch(filePath, ctx.workspaceRoot()) : undefined;
  ctx.tabs.setTabMode(filePath, mode, diffPatch);
}

function shouldExitDiffOnReopen(existing: TabEntry, opts?: OpenFileRequest): boolean {
  if (opts?.openInDiff || Boolean(opts?.location?.line)) return false;
  return existing.doc.mode() === "diff" && existing.doc.file().classification.kind !== "diff";
}

async function activateExistingTab(
  ctx: SessionCtx,
  existing: TabEntry,
  filePath: string,
  opts?: OpenFileRequest,
): Promise<void> {
  ctx.openError.set(null);
  if (opts?.openInDiff && existing.doc.mode() !== "diff") {
    await setFileModeInSession(ctx, filePath, "diff");
  } else if (shouldExitDiffOnReopen(existing, opts)) {
    ctx.tabs.setTabMode(filePath, existing.doc.file().classification.defaultMode);
  }
  ctx.tabs.openTab(toLoadedFileSnapshot(existing), { location: opts?.location });
  ctx.selectedPath.set(filePath);
}

async function loadFreshTabFile(
  ctx: SessionCtx,
  filePath: string,
  root: string,
  openInDiff?: boolean,
): Promise<LoadedFile | null> {
  const gitStatus = lookupGitStatus(filePath, root, ctx.snapshot().gitStatusMap);
  const warm = getPreloadedFile(filePath, root, gitStatus, openInDiff);
  if (warm) return warm;
  try {
    return await loadTabFile(filePath, root, openInDiff ? "diff" : undefined, gitStatus);
  } catch (err) {
    ctx.openError.set(describeFailure("open", path.basename(filePath), err));
    return null;
  }
}

async function openFileInSession(
  ctx: SessionCtx,
  filePath: string,
  opts?: OpenFileRequest,
): Promise<void> {
  const existing = ctx.tabs.getTab(filePath);
  if (existing) {
    await activateExistingTab(ctx, existing, filePath, opts);
    return;
  }
  const loaded = await loadFreshTabFile(ctx, filePath, ctx.workspaceRoot(), opts?.openInDiff);
  if (!loaded) return;
  ctx.openError.set(null);
  ctx.tabs.openTab(loaded, { location: opts?.location });
  ctx.selectedPath.set(filePath);
}

async function openLooseClickFile(
  ctx: SessionCtx,
  filePath: string,
  location: TabLocation | null,
): Promise<void> {
  const existing = ctx.tabs.getTab(filePath);
  const loaded = existing
    ? toLoadedFileSnapshot(existing)
    : await loadFreshTabFile(ctx, filePath, "");
  if (!loaded) return;
  clearWorkspaceTree(ctx);
  ctx.openError.set(null);
  ctx.tabs.openTab(loaded, { location });
  ctx.selectedPath.set(filePath);
}

async function openExternalInSession(
  ctx: SessionCtx,
  rawRef: string,
  origin: ExternalOrigin = "click",
): Promise<void> {
  const target = await resolveExternalFileReference(rawRef);
  if (!target) {
    const name = path.basename(normalizeExternalFilePath(rawRef) || rawRef);
    ctx.openError.set(describeFailure("open", name, new Error("no such file")));
    return;
  }
  const location = target.line > 0 ? { line: target.line, column: target.column } : null;
  if (target.isDirectory) switchToWorkspace(ctx, target.path);
  else if (externalOpenKeepsTree(origin)) await openFileInSession(ctx, target.path, { location });
  else await openLooseClickFile(ctx, target.path, location);
  if (desktopAvailable) Window.orderFront();
}

function selectTabInSession(ctx: SessionCtx, filePath: string): void {
  ctx.openError.set(null);
  ctx.tabs.activateTab(filePath);
  ctx.selectedPath.set(filePath);
}

function closeTabInSession(ctx: SessionCtx, filePath: string): void {
  const isDirty = Boolean(ctx.tabs.getTab(filePath)?.doc.dirty());
  withUnsavedGuard(ctx, "close-tab", isDirty ? [filePath] : [], () => {
    const nextActive = ctx.tabs.closeTab(filePath);
    if (ctx.selectedPath() === filePath) ctx.selectedPath.set(nextActive);
  });
}

async function saveFileInSession(ctx: SessionCtx, filePath: string): Promise<SaveOutcome> {
  const outcome = await saveInStore(ctx.tabs.fileStore, filePath, (file, text) =>
    saveFileText(file, text, ctx.workspaceRoot()),
  );
  if (outcome !== "saved") return outcome;
  if (ctx.tabs.getTab(filePath)?.doc.mode() === "diff") {
    await setFileModeInSession(ctx, filePath, "diff");
  }
  await refreshWorkspace(ctx);
  return outcome;
}

async function writeRelocatedCopy(ctx: SessionCtx, target: string, moved: TabEntry): Promise<void> {
  moved.doc.diskStamp.set(null);
  moved.doc.saveError.set(null);
  try {
    const saved = await saveFileText(
      toLoadedFileSnapshot(moved),
      moved.doc.text(),
      ctx.workspaceRoot(),
    );
    ctx.tabs.applySavedTab(target, saved);
    if (moved.doc.mode() === "diff") await setFileModeInSession(ctx, target, "diff");
    await refreshWorkspace(ctx);
  } catch (err) {
    ctx.tabs.setTabSaveError(target, describeFailure("save", target, err));
  }
}

async function saveCopyAsInSession(ctx: SessionCtx, filePath: string): Promise<void> {
  const tab = ctx.tabs.getTab(filePath);
  const target = tab ? await pickSavePath(toLoadedFileSnapshot(tab)) : null;
  if (!target) return;
  ctx.tabs.migrateRenamedTabs([[filePath, target]], ctx.workspaceRoot());
  if (ctx.selectedPath() === filePath) ctx.selectedPath.set(target);
  const moved = ctx.tabs.getTab(target);
  if (moved) await writeRelocatedCopy(ctx, target, moved);
}

async function resolveConflictInSession(
  ctx: SessionCtx,
  choice: "reload" | "keep",
): Promise<void> {
  const filePath = ctx.tabs.activePath();
  const tab = filePath ? ctx.tabs.getTab(filePath) : undefined;
  if (!filePath || !tab) return;
  if (choice === "keep") {
    const stamp = (await readDiskStamp(filePath)) ?? tab.doc.diskStamp();
    ctx.tabs.keepTabEdits(filePath, stamp);
    return;
  }
  const fresh = await reloadFromDisk(toLoadedFileSnapshot(tab), ctx.workspaceRoot());
  if (fresh) ctx.tabs.reloadTab(filePath, fresh);
}

async function saveAllAndProceed(ctx: SessionCtx, guard: PendingUnsavedGuard): Promise<void> {
  for (const p of guard.dirtyPaths) {
    if ((await saveFileInSession(ctx, p)) === "failed") {
      ctx.pendingUnsaved.set(null);
      selectTabInSession(ctx, p);
      return;
    }
  }
  ctx.pendingUnsaved.set(null);
  guard.onProceed();
}

function bindWorkspaceDiskPoller(ctx: SessionCtx): void {
  let lastStamp = "";
  let lastRoot = "";

  watchActiveInterval({
    baseMs: WORKSPACE_POLL_MS,
    maxMs: WORKSPACE_POLL_MAX_MS,
    lifecycle,
    enabled: () => ctx.workspaceRoot().length > 0,
    onResume: () => void refreshWorkspace(ctx),
    tick: async () => {
      const root = ctx.workspaceRoot();
      if (!root) return false;
      if (root !== lastRoot) {
        lastRoot = root;
        lastStamp = "";
      }
      const stamp = await readFolderStamps([root, ...ctx.expandedIds()]);
      if (stamp !== lastStamp) {
        lastStamp = stamp;
        await refreshWorkspace(ctx);
        return true;
      }
      const current = ctx.snapshot();
      if (!current.isGitRepo) return false;
      const gitStatusMap = await readGitStatus(root);
      if (ctx.workspaceRoot() !== root || current.root !== root) return false;
      if (sameGitStatus(gitStatusMap, current.gitStatusMap)) return false;
      ctx.snapshot.set(withGitStatus(current, gitStatusMap));
      ctx.tabs.syncGitStatus(root, gitStatusMap);
      return true;
    },
  });
}

function bindActiveTabDiskPoller(ctx: SessionCtx): void {
  const runCheck = watchActiveInterval({
    baseMs: DISK_CHECK_MS,
    maxMs: DISK_CHECK_MS,
    lifecycle,
    enabled: () => ctx.tabs.activePath() !== null,
    tick: async () => {
      const filePath = ctx.tabs.activePath();
      if (!filePath || !ctx.tabs.getTab(filePath)) return false;
      const disk = await statDisk(filePath);
      return ctx.tabs.reconcileTabDisk(filePath, disk, (t, d) =>
        reloadFromDisk(toLoadedFileSnapshot(t), ctx.workspaceRoot(), d),
      );
    },
  });
  effect(() => {
    const active = ctx.tabs.activePath();
    if (!active) return;
    untracked(() => void runCheck());
  });
}

function bindColdStartAndQueueEffects(
  ctx: SessionCtx,
  initialRoot: string,
  drainFinderOpenQueue: () => Promise<void>,
): void {
  let initialized = false;
  effect(() => {
    if (initialized) return;
    initialized = true;
    if (initialRoot) ctx.rememberWorkspace(initialRoot);
    deferOutOfEffect(() => void refreshWorkspace(ctx));
    void (async () => {
      const initFile = getInitialOpenFile();
      if (initFile) await openExternalInSession(ctx, initFile, "click");
      await drainFinderOpenQueue();
      await initUserPreferences(ctx.prefs);
    })();
  });

  effect(() => {
    const stopHostQueue = host.on("enqueueFinderOpen", (payload) => {
      if (typeof payload === "string" && payload.length > 0) {
        void openExternalInSession(ctx, payload, "click");
      }
    });
    if (!resolveFinderQueueDir()) {
      cleanup(() => stopHostQueue());
      return;
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      void drainFinderOpenQueue();
      if (ticks >= 16) clearInterval(timer);
    }, 150);
    cleanup(() => {
      stopHostQueue();
      clearInterval(timer);
    });
  });
}

interface PreferenceControls {
  setFontFamily: (next: string) => void;
  adjustFontSize: (delta: number) => void;
  selectTheme: (nextId: string) => void;
  cycleTheme: () => void;
  setShellPath: (next: string) => void;
  resetFont: () => void;
}

function createPreferenceControls(prefs: PreferenceSignals): PreferenceControls {
  const selectTheme = (nextId: string) => {
    const resolved = getThemeById(nextId);
    prefs.themeId.set(resolved.id);
    Storage.setItem("aed.theme", resolved.id);
  };
  return {
    setFontFamily: (next) => {
      prefs.fontFamily.set(next);
      Storage.setItem("aed.fontFamily", next);
    },
    adjustFontSize: (delta) => {
      const clamped = Math.max(9, Math.min(28, prefs.fontSize() + delta));
      prefs.fontSize.set(clamped);
      Storage.setItem("aed.fontSize", String(clamped));
    },
    selectTheme,
    cycleTheme: () => {
      const idx = EDITOR_THEMES.findIndex((t) => t.id === prefs.themeId());
      selectTheme(EDITOR_THEMES[(idx + 1) % EDITOR_THEMES.length].id);
    },
    setShellPath: (next) => {
      prefs.defaultShell.set(next);
      Storage.setItem("aed.shell", next);
    },
    resetFont: () => {
      prefs.fontSize.set(DEFAULT_FONT_SIZE);
      Storage.setItem("aed.fontSize", String(DEFAULT_FONT_SIZE));
    },
  };
}

function buildSessionActions(
  ctx: SessionCtx,
  prefControls: PreferenceControls,
  handleOpenFolder: () => Promise<void>,
  drainFinderOpenQueue: () => Promise<void>,
  quit: () => void,
): AppActions {
  const withActive = (fn: (p: string) => void) => () => {
    const cur = ctx.tabs.activePath();
    if (cur) fn(cur);
  };
  return {
    toggleSidebar: () => {
      if (!canToggleSidebar(ctx.workspaceRoot())) return;
      animatePanelToggle();
      ctx.sidebarOpen.update((v) => !v);
    },
    toggleTerminal: () => {
      animatePanelToggle();
      ctx.terminalOpen.update((v) => !v);
    },
    openFolder: () => void handleOpenFolder(),
    closeFolder: () => closeWorkspace(ctx),
    openQuickOpen: () => {
      ctx.commandMode.set("files");
      ctx.commandOpen.set(true);
    },
    openCommandPalette: () => {
      ctx.commandMode.set("commands");
      ctx.commandOpen.set(true);
    },
    openFontSettings: () => ctx.fontDialogOpen.set(true),
    adjustFontSize: prefControls.adjustFontSize,
    resetFont: prefControls.resetFont,
    saveCurrent: withActive((p) => void saveFileInSession(ctx, p)),
    closeCurrent: withActive((p) => closeTabInSession(ctx, p)),
    toggleTheme: prefControls.cycleTheme,
    refresh: () => void refreshWorkspace(ctx),
    setMode: (mode) => withActive((p) => void setFileModeInSession(ctx, p, mode))(),
    openQueuedFiles: () => void drainFinderOpenQueue(),
    quit,
  };
}

const HOME_DIR = os.homedir();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusKindDetail(file: LoadedFile): string | null {
  const kind = file.classification.kind;
  if (kind === "image" || kind === "video" || kind === "audio") return formatMediaMeta(file);
  if (kind === "quicklook") return (file.name.split(".").pop() || "PDF").toUpperCase();
  if (kind === "table" || kind === "binary") return null;
  return file.classification.language || kind;
}

function buildStatusSegments(
  file: LoadedFile | undefined,
  root: string,
  cursor: { line: number; col: number },
): string[] {
  if (!file) return [];
  const labelPath = root ? file.relPath : shortenHomePath(file.path, HOME_DIR);
  const sizePart =
    file.classification.kind === "table"
      ? `${file.tableData?.rows.length ?? 0} rows`
      : formatBytes(file.size);
  const out = [labelPath, sizePart];
  if (getActiveView(file) === "editor") out.push(`Ln ${cursor.line}, Col ${cursor.col}`);
  const detail = statusKindDetail(file);
  if (detail) out.push(detail);
  return out;
}

function formatFolderLabel(root: string): string {
  if (!root) return "Quick Open";
  return root.split("/").filter(Boolean).pop() || "workspace";
}

function computeActiveReveal(tab: TabEntry | undefined): FileLocation | null {
  const rev = tab?.view.pendingReveal();
  return tab && rev ? { path: tab.path(), line: rev.line, column: rev.column } : null;
}

function computeActiveFile(tab: TabEntry | undefined): LoadedFile | undefined {
  return tab ? toLoadedFileSnapshot(tab) : undefined;
}

function computeActiveCursor(tab: TabEntry | undefined): { line: number; col: number } {
  return tab ? tab.view.cursor() : { line: 1, col: 1 };
}

function selectFilteredTree(mode: "all" | "changed", snap: WorkspaceSnapshot): TreeItem[] {
  return mode === "all" ? snap.treeItemsAll : snap.treeItemsChanged;
}

function setActiveTabCursor(ctx: SessionCtx, line: number, col: number): void {
  const tab = ctx.tabs.activeTab();
  if (tab) tab.view.cursor.set({ line: line + 1, col: col + 1 });
}

function clearActiveTabReveal(ctx: SessionCtx): void {
  const tab = ctx.tabs.activeTab();
  if (tab) tab.view.pendingReveal.set(null);
}

function dismissActiveSaveError(ctx: SessionCtx): void {
  const cur = ctx.tabs.activePath();
  if (cur) ctx.tabs.setTabSaveError(cur, null);
}

async function pickAndSwitchWorkspace(ctx: SessionCtx): Promise<void> {
  const chosen = await pickWorkspaceFolder(ctx.workspaceRoot());
  if (chosen) switchToWorkspace(ctx, chosen);
}

function routePaletteSelection(
  ctx: SessionCtx,
  itemId: string,
  handleOpenFolder: () => Promise<void>,
): void {
  if (itemId === OPEN_FOLDER_CMD_ID) void handleOpenFolder();
  else if (itemId.startsWith("recent:")) switchToWorkspace(ctx, itemId.slice(7));
  else void openFileInSession(ctx, itemId);
}

function createInitialSessionCtx(initialRoot: string): SessionCtx {
  const recentWorkspaces = signal<string[]>([]);
  const recentLoaded = getStorageWithFallback("recentWorkspaces").then((raw) =>
    recentWorkspaces.set(parseRecentWorkspaces(raw)),
  );
  const prefs: PreferenceSignals = {
    fontFamily: signal<string>(DEFAULT_FONT_FAMILY),
    fontSize: signal<number>(DEFAULT_FONT_SIZE),
    themeId: signal<string>(DEFAULT_THEME_ID),
    defaultShell: signal<string>("/bin/zsh"),
    availableShells: signal<ShellProfile[]>([
      { name: "zsh", path: "/bin/zsh" },
      { name: "bash", path: "/bin/bash" },
      { name: "sh", path: "/bin/sh" },
    ]),
  };
  return {
    workspaceRoot: signal<string>(initialRoot),
    recentWorkspaces,
    snapshot: signal<WorkspaceSnapshot>(emptySnapshot()),
    filterMode: signal<"all" | "changed">("all"),
    expandedIds: signal<string[]>([]),
    selectedPath: signal<string | null>(null),
    tabs: createTabStore(),
    sidebarOpen: signal<boolean>(true),
    sidebarWidth: signal<number>(240),
    terminalOpen: signal<boolean>(false),
    terminalHeight: signal<number>(224),
    commandOpen: signal<boolean>(false),
    commandMode: signal<"files" | "commands">("files"),
    prefs,
    fontDialogOpen: signal<boolean>(false),
    pendingUnsaved: signal<PendingUnsavedGuard | null>(null),
    openError: signal<string | null>(null),
    scanGen: { value: 0 },
    rememberWorkspace: (folderPath) =>
      void recentLoaded.then(() => recordRecentWorkspace(recentWorkspaces, folderPath)),
  };
}

export interface WorkspaceSession {
  workspaceRoot: Signal<string>;
  folderLabel: Accessor<string>;
  recentWorkspaces: Signal<string[]>;
  snapshot: Signal<WorkspaceSnapshot>;
  filterMode: Signal<"all" | "changed">;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  tabs: TabStore;
  activeTab: Accessor<TabEntry | undefined>;
  activeFile: Accessor<LoadedFile | undefined>;
  activeModeItems: Accessor<SegmentedItem<PreviewMode>[]>;
  activeReveal: Accessor<FileLocation | null>;
  activeCursor: Accessor<{ line: number; col: number }>;
  statusSegments: Accessor<string[]>;
  sessionMode: Accessor<WindowMode>;
  editorSurface: Accessor<EditorSurface>;
  sidebarOpen: Signal<boolean>;
  sidebarWidth: Signal<number>;
  terminalOpen: Signal<boolean>;
  terminalHeight: Signal<number>;
  commandOpen: Signal<boolean>;
  commandMode: Signal<"files" | "commands">;
  fontFamily: Signal<string>;
  fontSize: Signal<number>;
  themeId: Signal<string>;
  activeTheme: Accessor<EditorTheme>;
  defaultShell: Signal<string>;
  availableShells: Signal<ShellProfile[]>;
  fontDialogOpen: Signal<boolean>;
  pendingUnsaved: Signal<PendingUnsavedGuard | null>;
  openError: Signal<string | null>;
  changedCount: Accessor<number>;
  treeItems: Accessor<TreeItem[]>;
  paletteFileItems: Accessor<CommandItem[]>;
  edited: Accessor<boolean>;
  actions: AppActions;
  setFontFamily: (next: string) => void;
  adjustFontSize: (delta: number) => void;
  selectTheme: (nextId: string) => void;
  setShellPath: (next: string) => void;
  resetFont: () => void;
  switchToWorkspace: (folderPath: string) => void;
  closeWorkspace: () => void;
  handleOpenFolder: () => Promise<void>;
  selectTab: (filePath: string) => void;
  closeTab: (filePath: string) => void;
  openFileInTab: (filePath: string, opts?: OpenFileRequest) => Promise<void>;
  openExternalFile: (rawRef: string, origin?: ExternalOrigin) => Promise<void>;
  handlePaletteSelectFile: (itemId: string) => void;
  handleTextChange: (filePath: string, nextText: string) => void;
  handleCursorChange: (line: number, col: number) => void;
  clearActiveReveal: () => void;
  setFileMode: (filePath: string, mode: PreviewMode) => Promise<void>;
  saveFile: (filePath: string) => Promise<SaveOutcome>;
  saveCopyAs: (filePath: string) => Promise<void>;
  resolveConflict: (choice: "reload" | "keep") => Promise<void>;
  dismissSaveError: () => void;
  handleSaveAndProceed: (guard: PendingUnsavedGuard) => Promise<void>;
  handleDiscardAndProceed: (guard: PendingUnsavedGuard) => void;
}

export function createWorkspaceSession(): WorkspaceSession {
  const initialRoot = getInitialWorkspaceRoot();
  const ctx = createInitialSessionCtx(initialRoot);
  const prefs = ctx.prefs;

  const activeTheme = computed(() => getThemeById(prefs.themeId()));
  effect(() => {
    const theme = activeTheme();
    setColorScheme(theme.appearance);
    void syncThemeTokens(theme);
  });

  const sessionMode = computed(() =>
    deriveWindowMode(ctx.workspaceRoot(), ctx.tabs.tabs().length),
  );
  effect(() => {
    void syncWindowStateFile(sessionMode(), ctx.workspaceRoot());
  });

  const drainFinderOpenQueue = serialize(async () => {
    const queued = await consumeFinderOpenQueue();
    for (const ref of queued) await openExternalInSession(ctx, ref, "click");
  });

  bindColdStartAndQueueEffects(ctx, initialRoot, drainFinderOpenQueue);
  bindActiveTabDiskPoller(ctx);
  bindWorkspaceDiskPoller(ctx);

  const handleOpenFolder = () => pickAndSwitchWorkspace(ctx);
  const prefControls = createPreferenceControls(prefs);
  const quitting = createQuitController(
    (act, dirty, proceed) => withUnsavedGuard(ctx, act, dirty, proceed),
    () => ctx.tabs.dirtyPaths(),
  );
  const actions = buildSessionActions(
    ctx,
    prefControls,
    handleOpenFolder,
    drainFinderOpenQueue,
    quitting.quit,
  );
  const activeFile = computed(() => computeActiveFile(ctx.tabs.activeTab()));
  const activeCursor = computed(() => computeActiveCursor(ctx.tabs.activeTab()));

  return {
    workspaceRoot: ctx.workspaceRoot,
    folderLabel: computed(() => formatFolderLabel(ctx.workspaceRoot())),
    recentWorkspaces: ctx.recentWorkspaces,
    snapshot: ctx.snapshot,
    filterMode: ctx.filterMode,
    expandedIds: ctx.expandedIds,
    selectedPath: ctx.selectedPath,
    tabs: ctx.tabs,
    activeTab: ctx.tabs.activeTab,
    activeFile,
    activeModeItems: computed(() => computeTabModeItems(ctx.tabs.activeTab())),
    activeReveal: computed(() => computeActiveReveal(ctx.tabs.activeTab())),
    activeCursor,
    statusSegments: computed(() =>
      buildStatusSegments(activeFile(), ctx.workspaceRoot(), activeCursor()),
    ),
    sessionMode,
    editorSurface: computed(() =>
      deriveEditorSurface(ctx.workspaceRoot(), ctx.tabs.activeTab() !== undefined),
    ),
    sidebarOpen: ctx.sidebarOpen,
    sidebarWidth: ctx.sidebarWidth,
    terminalOpen: ctx.terminalOpen,
    terminalHeight: ctx.terminalHeight,
    commandOpen: ctx.commandOpen,
    commandMode: ctx.commandMode,
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    themeId: prefs.themeId,
    activeTheme,
    defaultShell: prefs.defaultShell,
    availableShells: prefs.availableShells,
    fontDialogOpen: ctx.fontDialogOpen,
    pendingUnsaved: ctx.pendingUnsaved,
    openError: ctx.openError,
    changedCount: computed(() => Object.keys(ctx.snapshot().gitStatusMap).length),
    treeItems: computed(() => selectFilteredTree(ctx.filterMode(), ctx.snapshot())),
    paletteFileItems: computed(() =>
      buildQuickOpenItems(
        ctx.workspaceRoot(),
        ctx.snapshot().commandItems,
        ctx.recentWorkspaces(),
      ),
    ),
    edited: quitting.edited,
    actions,
    setFontFamily: prefControls.setFontFamily,
    adjustFontSize: prefControls.adjustFontSize,
    selectTheme: prefControls.selectTheme,
    setShellPath: prefControls.setShellPath,
    resetFont: prefControls.resetFont,
    switchToWorkspace: (p) => switchToWorkspace(ctx, p),
    closeWorkspace: () => closeWorkspace(ctx),
    handleOpenFolder,
    selectTab: (p) => selectTabInSession(ctx, p),
    closeTab: (p) => closeTabInSession(ctx, p),
    openFileInTab: (p, opts) => openFileInSession(ctx, p, opts),
    openExternalFile: (raw, origin) => openExternalInSession(ctx, raw, origin),
    handlePaletteSelectFile: (id) => routePaletteSelection(ctx, id, handleOpenFolder),
    handleTextChange: (p, text) => ctx.tabs.updateTabBufferText(p, text),
    handleCursorChange: (line, col) => setActiveTabCursor(ctx, line, col),
    clearActiveReveal: () => clearActiveTabReveal(ctx),
    setFileMode: (p, m) => setFileModeInSession(ctx, p, m),
    saveFile: (p) => saveFileInSession(ctx, p),
    saveCopyAs: (p) => saveCopyAsInSession(ctx, p),
    resolveConflict: (choice) => resolveConflictInSession(ctx, choice),
    dismissSaveError: () => dismissActiveSaveError(ctx),
    handleSaveAndProceed: (g) => saveAllAndProceed(ctx, g),
    handleDiscardAndProceed: (g) => {
      ctx.pendingUnsaved.set(null);
      g.onProceed();
    },
  };
}
