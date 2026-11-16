import * as path from "path";
import { effect, keymap, type Accessor } from "nsh";
import type { CommandItem } from "nsh/base";
import {
  isAvailable as desktopAvailable,
  Menu as DesktopMenu,
  Window,
} from "nsh/desktop";
import type { PreviewMode } from "./classify";
import { windowTitle } from "./session";

export const MIN_WINDOW_WIDTH = 760;
export const MIN_WINDOW_HEIGHT = 520;
export const OPEN_FOLDER_CMD_ID = "cmd:open-folder";

export interface AppActions {
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  openFolder: () => void;
  closeFolder: () => void;
  openQuickOpen: () => void;
  openCommandPalette: () => void;
  openFontSettings: () => void;
  adjustFontSize: (delta: number) => void;
  resetFont: () => void;
  saveCurrent: () => void;
  closeCurrent: () => void;
  toggleTheme: () => void;
  refresh: () => void;
  setMode: (mode: PreviewMode) => void;
  openQueuedFiles: () => void;
  quit: () => void;
}

export const BUILT_IN_COMMANDS: readonly CommandItem[] = [
  { id: "configure-font", label: "Preferences: Theme, Font & Terminal...", shortcut: "mod+,", keywords: ["font", "size", "family", "theme", "color", "shell", "preferences", "settings"] },
  { id: "font-size-inc", label: "View: Increase Font Size", shortcut: "mod+=", keywords: ["font", "zoom", "larger"] },
  { id: "font-size-dec", label: "View: Decrease Font Size", shortcut: "mod+-", keywords: ["font", "zoom", "smaller"] },
  { id: "toggle-sidebar", label: "View: Toggle Sidebar", shortcut: "mod+b", keywords: ["sidebar", "explorer"] },
  { id: "toggle-terminal", label: "View: Toggle Terminal", shortcut: "mod+j", keywords: ["terminal", "pty", "console"] },
  { id: "open-folder", label: "File: Open Folder...", shortcut: "mod+o", keywords: ["open", "folder", "workspace"] },
  { id: "close-folder", label: "File: Close Folder", shortcut: "mod+shift+w", keywords: ["close", "folder", "workspace", "welcome", "home"] },
  { id: "save-file", label: "File: Save Current File", shortcut: "mod+s", keywords: ["save", "write"] },
  { id: "close-tab", label: "View: Close Current Tab", shortcut: "mod+w", keywords: ["close", "tab"] },
  { id: "quit", label: "File: Quit Aed", shortcut: "mod+q", keywords: ["quit", "exit"] },
  { id: "toggle-theme", label: "Preferences: Cycle Color Theme", keywords: ["theme", "light", "dark", "color"] },
  { id: "refresh-workspace", label: "Explorer: Refresh Workspace", shortcut: "mod+r", keywords: ["refresh", "reload"] },
  { id: "mode-preview", label: "View: Switch to Preview Mode", keywords: ["preview"] },
  { id: "mode-source", label: "View: Switch to Source Mode", keywords: ["source", "code"] },
  { id: "mode-diff", label: "View: Switch to Diff Mode", keywords: ["diff", "git"] },
];

const COMMAND_HANDLERS: Record<string, (actions: AppActions) => void> = {
  "configure-font": (a) => a.openFontSettings(),
  "font-size-inc": (a) => a.adjustFontSize(1),
  "font-size-dec": (a) => a.adjustFontSize(-1),
  "toggle-sidebar": (a) => a.toggleSidebar(),
  "toggle-terminal": (a) => a.toggleTerminal(),
  "open-folder": (a) => a.openFolder(),
  "close-folder": (a) => a.closeFolder(),
  "save-file": (a) => a.saveCurrent(),
  "close-tab": (a) => a.closeCurrent(),
  quit: (a) => a.quit(),
  "toggle-theme": (a) => a.toggleTheme(),
  "refresh-workspace": (a) => a.refresh(),
  "mode-preview": (a) => a.setMode("preview"),
  "mode-source": (a) => a.setMode("source"),
  "mode-diff": (a) => a.setMode("diff"),
};

export function runBuiltInCommand(commandId: string, actions: AppActions): void {
  COMMAND_HANDLERS[commandId]?.(actions);
}

/** Build Quick Open items; when no folder is open, list recent folders plus `Open Folder…`. */
export function buildQuickOpenItems(
  workspaceRoot: string,
  commandItems: CommandItem[],
  recentWorkspaces: readonly string[],
): CommandItem[] {
  if (workspaceRoot.length > 0) return commandItems;
  const recent: CommandItem[] = recentWorkspaces.map((ws) => {
    const base = path.basename(ws) || ws;
    return {
      id: `recent:${ws}`,
      label: `${base} — ${ws}`,
      keywords: [base, ws],
      group: "Recent Workspaces",
    };
  });
  return [
    ...recent,
    {
      id: OPEN_FOLDER_CMD_ID,
      label: "Open Folder…",
      shortcut: "mod+o",
      keywords: ["open", "folder", "workspace"],
      group: "Actions",
    },
  ];
}

export function bindAppShortcuts(actions: AppActions): () => void {
  return keymap.bind({
    "mod+p": () => actions.openQuickOpen(),
    "mod+k": () => actions.openQuickOpen(),
    "mod+shift+p": () => actions.openCommandPalette(),
    "mod+,": () => actions.openFontSettings(),
    "mod+b": () => actions.toggleSidebar(),
    "mod+j": () => actions.toggleTerminal(),
    "ctrl+`": () => actions.toggleTerminal(),
    "mod+s": () => actions.saveCurrent(),
    "mod+w": () => actions.closeCurrent(),
    "mod+shift+w": () => actions.closeFolder(),
    "mod+o": () => actions.openFolder(),
    "mod+r": () => actions.refresh(),
    "mod+=": () => actions.adjustFontSize(1),
    "mod+-": () => actions.adjustFontSize(-1),
    "mod+0": () => actions.resetFont(),
  });
}

let lastEnforcedKey = "";

export function enforceMinWindowSize(width: number, height: number): void {
  if (!desktopAvailable || width <= 0 || height <= 0) return;
  const w = Math.round(width);
  const h = Math.round(height);
  if (w >= MIN_WINDOW_WIDTH && h >= MIN_WINDOW_HEIGHT) {
    lastEnforcedKey = "";
    return;
  }
  const key = `${w}x${h}`;
  if (key === lastEnforcedKey) return;
  lastEnforcedKey = key;
  Window.setFrame({
    size: {
      width: Math.max(w, MIN_WINDOW_WIDTH),
      height: Math.max(h, MIN_WINDOW_HEIGHT),
    },
  });
}

function buildApplicationMenu(
  actions: AppActions,
  recentWorkspaces: readonly string[],
  onSelectRecent: (folderPath: string) => void,
) {
  const recentItems = recentWorkspaces.map((ws) => ({
    label: path.basename(ws) || ws,
    onSelect: () => onSelectRecent(ws),
  }));
  return [
    {
      label: "Aed",
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { label: "Preferences...", shortcut: "mod+,", onSelect: () => actions.openFontSettings() },
        { type: "separator" as const },
        { role: "hide" as const, shortcut: "mod+h" },
        { role: "hideOthers" as const, shortcut: "mod+alt+h" },
        { role: "showAll" as const },
        { type: "separator" as const },
        { label: "Quit Aed", shortcut: "mod+q", onSelect: () => actions.quit() },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Folder...", shortcut: "mod+o", onSelect: () => actions.openFolder() },
        ...(recentItems.length > 0 ? [{ label: "Open Recent", submenu: recentItems }] : []),
        { label: "Quick Open...", shortcut: "mod+p", onSelect: () => actions.openQuickOpen() },
        { label: "Open Queued Files", onSelect: () => actions.openQueuedFiles() },
        { type: "separator" as const },
        { label: "Save", shortcut: "mod+s", onSelect: () => actions.saveCurrent() },
        { label: "Close Tab", shortcut: "mod+w", onSelect: () => actions.closeCurrent() },
        { label: "Close Folder", shortcut: "mod+shift+w", onSelect: () => actions.closeFolder() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const, shortcut: "mod+z" },
        { role: "redo" as const, shortcut: "mod+shift+z" },
        { type: "separator" as const },
        { role: "cut" as const, shortcut: "mod+x" },
        { role: "copy" as const, shortcut: "mod+c" },
        { role: "paste" as const, shortcut: "mod+v" },
        { role: "selectAll" as const, shortcut: "mod+a" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Command Palette...", shortcut: "mod+shift+p", onSelect: () => actions.openCommandPalette() },
        { label: "Refresh Workspace", shortcut: "mod+r", onSelect: () => actions.refresh() },
        { type: "separator" as const },
        { label: "Toggle Sidebar", shortcut: "mod+b", onSelect: () => actions.toggleSidebar() },
        { label: "Toggle Terminal", shortcut: "mod+j", onSelect: () => actions.toggleTerminal() },
        { type: "separator" as const },
        { role: "toggleFullScreen" as const, shortcut: "ctrl+mod+f" },
      ],
    },
  ];
}

export function setupDesktopChrome(
  actions: AppActions,
  recentWorkspaces: Accessor<string[]>,
  onSelectRecent: (folderPath: string) => void,
  edited: Accessor<boolean>,
): void {
  if (!desktopAvailable) return;
  Window.setTitleBar({ style: "hidden", height: 32 });
  Window.setFrame({ size: { width: 1280, height: 800 } });
  effect(() => Window.setTitle(windowTitle(edited())));
  effect(() => {
    DesktopMenu.setApplicationMenu(
      buildApplicationMenu(actions, recentWorkspaces(), onSelectRecent),
    );
  });
}
