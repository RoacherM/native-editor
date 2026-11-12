/**
 * Window session state machine — pure rules, no I/O. DESIGN.md「状态机清单」.
 *
 * The window is in exactly one mode, derived from two facts App owns:
 * `workspaceRoot` ("" = none) and the number of open tabs.
 *
 *   home      — no folder, no tabs: WelcomePanel
 *   workspace — a folder is open: file tree + tabs
 *   loose     — no folder, ≥ 1 tab (an external file): no file tree
 */

export type WindowMode = "home" | "workspace" | "loose";

/** What the editor area shows when no PreviewPane is active, or the file itself. */
export type EditorSurface = "file" | "welcome" | "workspace-empty";

/** The user-level events that move the window between modes. */
export type WindowEvent =
  | "open-folder"
  | "reopen-current-folder"
  | "close-folder"
  | "drop-file"
  | "click-file"
  | "close-last-tab";

/**
 * The whole machine in one table: `WINDOW_TRANSITIONS[mode][event]` is the
 * mode after the event. `nsh check` fails when a mode or event is added
 * without a row; `App.test.tsx` replays every cell through the functions
 * below, so the table cannot drift from the code App runs.
 * `drop-file` is any file dragged onto this window: it opens here as a tab
 * and the mode stays. `click-file` is an external click (Finder, Herdr,
 * `AED_OPEN_FILE`, I-007): always a tree-less window.
 * `reopen-current-folder` needs a folder; from `home` / `loose` it behaves
 * as `open-folder`.
 */
export const WINDOW_TRANSITIONS: Readonly<
  Record<WindowMode, Readonly<Record<WindowEvent, WindowMode>>>
> = {
  home: {
    "open-folder": "workspace",
    "reopen-current-folder": "workspace",
    "close-folder": "home",
    "drop-file": "loose",
    "click-file": "loose",
    "close-last-tab": "home",
  },
  workspace: {
    "open-folder": "workspace",
    "reopen-current-folder": "workspace",
    "close-folder": "home",
    "drop-file": "workspace",
    "click-file": "loose",
    "close-last-tab": "workspace",
  },
  loose: {
    "open-folder": "workspace",
    "reopen-current-folder": "workspace",
    "close-folder": "home",
    "drop-file": "loose",
    "click-file": "loose",
    "close-last-tab": "home",
  },
};

/** A folder path without trailing slashes; `/` becomes "" (never a workspace). */
export function normalizeRoot(folderPath: string): string {
  return folderPath.replace(/\/+$/, "");
}

export function deriveWindowMode(root: string, tabCount: number): WindowMode {
  if (root.length > 0) return "workspace";
  return tabCount > 0 ? "loose" : "home";
}

export function deriveEditorSurface(root: string, hasActiveFile: boolean): EditorSurface {
  if (hasActiveFile) return "file";
  return root.length > 0 ? "workspace-empty" : "welcome";
}

/** The sidebar exists only in `workspace` mode; toggling it elsewhere is a no-op. */
export function canToggleSidebar(root: string): boolean {
  return root.length > 0;
}

export type WorkspaceIntent = { kind: "open"; root: string } | { kind: "close" };

export type WorkspacePlan =
  | { action: "ignore" }
  | { action: "refresh" }
  | { action: "reset"; nextRoot: string };

/**
 * What a workspace intent does. `reset` clears tabs and file state and is
 * guarded by the unsaved-changes prompt; `refresh` keeps everything (the
 * folder is already open); `ignore` does nothing.
 */
export function planWorkspaceIntent(
  currentRoot: string,
  tabCount: number,
  intent: WorkspaceIntent
): WorkspacePlan {
  if (intent.kind === "close") {
    return deriveWindowMode(currentRoot, tabCount) === "home"
      ? { action: "ignore" }
      : { action: "reset", nextRoot: "" };
  }
  const nextRoot = normalizeRoot(intent.root);
  if (!nextRoot) return { action: "ignore" };
  if (nextRoot === normalizeRoot(currentRoot)) return { action: "refresh" };
  return { action: "reset", nextRoot };
}

export type ExternalOrigin = "click" | "drop";

/**
 * Whether opening an external file keeps this window's folder and tree.
 * A drop means "open it here": the file joins the tabs, from inside or
 * outside the folder. A click (Finder, Herdr, `AED_OPEN_FILE`) always gets a
 * tree-less window (DESIGN.md I-007).
 */
export function externalOpenKeepsTree(origin: ExternalOrigin): boolean {
  return origin === "drop";
}

/** The actions the unsaved-changes prompt guards. */
export type GuardedAction = "close-tab" | "close-folder" | "switch-folder" | "quit";

/** A guarded action waiting on the unsaved-changes prompt. */
export interface UnsavedGuard {
  action: GuardedAction;
  dirtyPaths: string[];
  onProceed: () => void;
}

const GUARD_ENDINGS: Record<GuardedAction, string> = {
  "close-tab": "before closing?",
  "close-folder": "before closing the folder?",
  "switch-folder": "before opening another folder?",
  quit: "before quitting?",
};

/** The prompt's question: which files, before which action. */
export function unsavedQuestion(action: GuardedAction, names: string): string {
  return `Save changes to ${names} ${GUARD_ENDINGS[action]}`;
}

/**
 * The window title while tabs have unsaved edits ends with this (macOS's own
 * wording). `scripts/finder_bridge.m` reads it: the close button and system
 * quits (Dock, logout) of an edited window go to the Quit menu item, which
 * asks first (DESIGN.md「术语与边界」).
 */
export const EDITED_TITLE_SUFFIX = " — Edited";

/** The window title: `Aed`, with EDITED_TITLE_SUFFIX while edits are unsaved. */
export function windowTitle(edited: boolean): string {
  return edited ? `Aed${EDITED_TITLE_SUFFIX}` : "Aed";
}

/**
 * The prompt is a two-state machine: idle (`pending === null`) or confirming.
 * `run`: no unsaved files, act now. `confirm`: show the prompt.
 * `busy`: a prompt is already open; the new action is dropped so it cannot
 * replace what the user is answering.
 */
export function decideGuard(
  pending: UnsavedGuard | null,
  dirtyPaths: readonly string[]
): "run" | "confirm" | "busy" {
  if (pending) return "busy";
  return dirtyPaths.length === 0 ? "run" : "confirm";
}

/** The tab that becomes active after `closing` closes (the last remaining one). */
export function nextActiveAfterClose(
  tabs: readonly string[],
  closing: string,
  active: string | null
): string | null {
  if (active !== closing) return active;
  const remaining = tabs.filter((p) => p !== closing);
  return remaining.length > 0 ? remaining[remaining.length - 1] : null;
}

/**
 * Wrap `task` so its runs never overlap: a call while one runs makes it run
 * once more afterwards (any number of such calls make one more run), also
 * when the run threw. App's disk check of the active tab runs through this.
 */
export function serialize(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (again) {
        again = false;
        await run();
      }
    }
  };
  return run;
}

/** How long a quit may take before Aed takes it as not carried out and arms the guard again. */
export const QUIT_SETTLE_MS = 2000;

/**
 * An approved quit (I-016). `setApproved(true)` drops the window's edited mark
 * so the native guard (`scripts/finder_bridge.m`) lets this quit through; the
 * exit runs on the next turn, after the title has changed. When the exit
 * throws, or the process is still here `settleMs` later (the host cancelled
 * it), the approval ends and the guard is armed again.
 */
export function runApprovedQuit(
  setApproved: (approved: boolean) => void,
  exitProcess: () => void,
  settleMs: number = QUIT_SETTLE_MS
): void {
  setApproved(true);
  setTimeout(() => {
    try {
      exitProcess();
    } catch {
      setApproved(false);
      return;
    }
    setTimeout(() => setApproved(false), settleMs);
  }, 0);
}
