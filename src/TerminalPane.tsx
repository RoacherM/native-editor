import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import process from "process";
import { type SessionEvent, type ShellOptions, TerminalSession } from "aed/native";
import type { Accessor, JSX, NativeComponentRef, Signal } from "nsh";
import {
  cleanup,
  computed,
  effect,
  host,
  keymap,
  nativeComponent,
  openUrl,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import { Select, type SelectItem } from "nsh/base";
import { Icon } from "./icons";
import { parseTarget, resolveTarget, type StatFn, type TargetOptions } from "./target";
import { buildTerminalTheme, type TerminalTheme } from "./terminalTheme";
import { EDITOR_THEMES, type EditorTheme } from "./themes";
import { IconButton, TabStrip } from "./ui";
import { deferOutOfEffect, onceAsync, statDisk } from "./workspace";

// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」. The terminal's tabs: a
// `TerminalSession` each (libghostty-vt and the shell on its PTY, native/),
// the native `aed.terminal` view that shows the active one, and the test
// channel.

export interface TerminalFileLocation {
  line: number;
  column: number;
}

export type TerminalFileOpenHandler =
  | ((filePath: string, location?: TerminalFileLocation) => unknown)
  | ((filePath: string, openInDiff?: boolean) => unknown);

export interface TerminalPaneProps {
  cwd: Accessor<string>;
  /** Whether the panel is shown; shells start the first time it is (none at launch). */
  visible: Accessor<boolean>;
  fontFamily?: Accessor<string>;
  fontSize?: Accessor<number>;
  shellPath?: Accessor<string>;
  theme?: Accessor<EditorTheme>;
  onShellChange?: (shellPath: string) => void;
  onFileOpen?: TerminalFileOpenHandler;
  /** The last tab's shell exited: the panel should close. */
  onEmpty?: () => void;
}

export interface ExternalTerminalApp {
  id: string;
  name: string;
  bundlePath: string;
  termProgram: string;
  resourcesDir?: string;
}

export interface ShellProfile {
  name: string;
  path: string;
}

export interface GhosttyConfig {
  fontFamily?: string;
  fontSize?: number;
  theme?: string;
  cursorColor?: string;
  command?: string;
}

export interface TerminalEnvironment {
  externalApps: ExternalTerminalApp[];
  shells: ShellProfile[];
  ghostty: GhosttyConfig;
}

export interface TerminalEnvIo {
  home: string;
  envShell?: string;
  readText: (filePath: string) => Promise<string | null>;
  pathExists: (targetPath: string) => Promise<boolean>;
}

interface TermTab {
  id: number;
  shell: Signal<ShellProfile>;
  /** The title the program set (OSC 0/2), "" for none. */
  programTitle: Signal<string>;
  title: Accessor<string>;
  /** The tab's terminal and the shell running in it. */
  session: TerminalSession;
  /** The directory the running shell started in; null while none runs. */
  startedIn: string | null;
  /** Holds the test channel's input until the running shell has drawn its first prompt. */
  gate: InputGate<Uint8Array> | null;
  /** The test channel typed into the running shell (perhaps still held by the gate). */
  typed: boolean;
  /** The test channel's plain-text copy of the screen (kept once the channel is used). */
  mirror: Signal<string[]>;
}

/** Quiet time after the shell's first output that means its prompt is drawn. */
const SHELL_QUIET_MS = 200;
/** Input is let through after this long even if the shell stays silent. */
const SHELL_READY_MAX_MS = 3000;

export interface InputGate<T> {
  /** Write `data` now if the shell is ready, else queue it. */
  send(data: T): void;
  /** The shell printed something. */
  output(): void;
  /** Let queued and later input through. */
  open(): void;
}

/**
 * Some shell setups drop input typed while they start (the TTY echoes it, then
 * the line editor flushes it). The gate queues input until the shell's first
 * output is followed by SHELL_QUIET_MS of quiet (the prompt is drawn), or
 * SHELL_READY_MAX_MS passed. `schedule` / `cancel` are injectable for tests,
 * and `onOpen` runs once when the gate opens.
 */
export function createInputGate<T>(
  write: (data: T) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onOpen?: () => void,
): InputGate<T> {
  let ready = false;
  let quiet: unknown;
  const queued: T[] = [];
  const open = () => {
    if (ready) return;
    ready = true;
    cancel(quiet);
    cancel(fallback);
    for (const data of queued.splice(0)) write(data);
    onOpen?.();
  };
  const fallback = schedule(open, SHELL_READY_MAX_MS);
  return {
    send: (data) => (ready ? write(data) : void queued.push(data)),
    output: () => {
      if (ready) return;
      cancel(quiet);
      quiet = schedule(open, SHELL_QUIET_MS);
    },
    open,
  };
}

/**
 * A shell the user has not typed into yet follows the open folder: it
 * restarts in `cwd`. A shell the user has typed into (even a half-typed
 * command: every key reaches the shell at once) keeps its directory, input
 * and whatever runs in it. DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」.
 */
export function shouldFollowCwd(
  session: { cwd: string; used: boolean } | undefined,
  cwd: string,
): boolean {
  return !!session && !session.used && session.cwd !== cwd;
}

interface TerminalAppCandidate {
  id: string;
  name: string;
  relBundle: string;
  termProgram: string;
  resourcesSubpath?: string;
}

const TERMINAL_APP_CANDIDATES: readonly TerminalAppCandidate[] = [
  {
    id: "ghostty",
    name: "Ghostty",
    relBundle: "Ghostty.app",
    termProgram: "ghostty",
    resourcesSubpath: "Contents/Resources/ghostty",
  },
  {
    id: "iterm",
    name: "iTerm2",
    relBundle: "iTerm.app",
    termProgram: "iTerm.app",
  },
  {
    id: "warp",
    name: "Warp",
    relBundle: "Warp.app",
    termProgram: "WarpTerminal",
  },
  {
    id: "kitty",
    name: "kitty",
    relBundle: "kitty.app",
    termProgram: "kitty",
  },
  {
    id: "wezterm",
    name: "WezTerm",
    relBundle: "WezTerm.app",
    termProgram: "WezTerm",
  },
  {
    id: "alacritty",
    name: "Alacritty",
    relBundle: "Alacritty.app",
    termProgram: "Alacritty",
  },
];

const SHELL_CANDIDATES = [
  "/bin/zsh",
  "/opt/homebrew/bin/fish",
  "/usr/local/bin/fish",
  "/opt/homebrew/bin/nu",
  "/opt/homebrew/bin/bash",
  "/bin/bash",
  "/bin/sh",
];

const SYSTEM_TERMINAL_BUNDLE = "/System/Applications/Utilities/Terminal.app";

function defaultTerminalEnvIo(): TerminalEnvIo {
  return {
    home: os.homedir(),
    envShell: process.env.SHELL,
    readText: async (filePath) => {
      try {
        const bytes = await fs.readFile(filePath);
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        return null;
      }
    },
    pathExists: async (targetPath) => (await statDisk(targetPath)) !== null,
  };
}

function parseGhosttyFontSize(val: string): number | undefined {
  const n = Number(val);
  return !Number.isNaN(n) && n >= 9 && n <= 28 ? n : undefined;
}

const GHOSTTY_CONFIG_APPLIERS: Record<string, (cfg: GhosttyConfig, val: string) => void> = {
  "font-family": (cfg, val) => {
    if (!cfg.fontFamily) cfg.fontFamily = val;
  },
  "font-size": (cfg, val) => {
    const size = parseGhosttyFontSize(val);
    if (size !== undefined) cfg.fontSize = size;
  },
  theme: (cfg, val) => {
    cfg.theme = val;
  },
  "cursor-color": (cfg, val) => {
    cfg.cursorColor = val;
  },
  command: (cfg, val) => {
    cfg.command = val;
  },
};

function parseGhosttyConfigLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  return key && val ? [key, val] : null;
}

/** Parse Ghostty's key = value config text. */
export function parseGhosttyConfig(raw: string): GhosttyConfig {
  const cfg: GhosttyConfig = {};
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseGhosttyConfigLine(line);
    if (entry) GHOSTTY_CONFIG_APPLIERS[entry[0]]?.(cfg, entry[1]);
  }
  return cfg;
}

async function loadGhosttyConfig(
  home: string,
  readText: (filePath: string) => Promise<string | null>,
): Promise<GhosttyConfig> {
  const paths = [
    path.join(home, ".config/ghostty/config.ghostty"),
    path.join(home, ".config/ghostty/config"),
    path.join(home, "Library/Application Support/com.mitchellh.ghostty/config.ghostty"),
    path.join(home, "Library/Application Support/com.mitchellh.ghostty/config"),
  ];
  const rawContents = await Promise.all(paths.map((p) => readText(p)));
  let merged: GhosttyConfig = {};
  for (const text of rawContents) {
    if (text !== null) merged = { ...merged, ...parseGhosttyConfig(text) };
  }
  return merged;
}

async function probeTerminalCandidate(
  cand: TerminalAppCandidate,
  appDirs: readonly string[],
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<ExternalTerminalApp | null> {
  const bundlePaths = appDirs.map((dir) => path.join(dir, cand.relBundle));
  const hits = await Promise.all(bundlePaths.map((bp) => pathExists(bp)));
  const idx = hits.indexOf(true);
  if (idx < 0) return null;
  const bundlePath = bundlePaths[idx];
  return {
    id: cand.id,
    name: cand.name,
    bundlePath,
    termProgram: cand.termProgram,
    resourcesDir: cand.resourcesSubpath ? path.join(bundlePath, cand.resourcesSubpath) : undefined,
  };
}

async function detectExternalTerminals(
  home: string,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<ExternalTerminalApp[]> {
  const appDirs = ["/Applications", path.join(home, "Applications")];
  const [candidates, hasSysTerm] = await Promise.all([
    Promise.all(
      TERMINAL_APP_CANDIDATES.map((cand) => probeTerminalCandidate(cand, appDirs, pathExists)),
    ),
    pathExists(SYSTEM_TERMINAL_BUNDLE),
  ]);
  const found = candidates.filter((app): app is ExternalTerminalApp => app !== null);
  if (hasSysTerm) {
    found.push({
      id: "apple-terminal",
      name: "Terminal",
      bundlePath: SYSTEM_TERMINAL_BUNDLE,
      termProgram: "Apple_Terminal",
    });
  }
  return found;
}

function defaultShellProfile(envShell = process.env.SHELL): ShellProfile {
  const shellPath = envShell || "/bin/zsh";
  return { name: path.basename(shellPath) || "shell", path: shellPath };
}

function collectUniqueShellPaths(
  ghosttyCommand: string | undefined,
  envShell: string | undefined,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of [ghosttyCommand, envShell, ...SHELL_CANDIDATES]) {
    if (!raw) continue;
    const clean = raw.trim().split(/\s+/)[0];
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    ordered.push(clean);
  }
  return ordered;
}

async function detectShellProfiles(
  ghosttyCommand: string | undefined,
  envShell: string | undefined,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<ShellProfile[]> {
  const candidates = collectUniqueShellPaths(ghosttyCommand, envShell);
  const hits = await Promise.all(candidates.map((cand) => pathExists(cand)));
  const profiles = candidates
    .filter((_, idx) => hits[idx])
    .map((clean) => ({ name: path.basename(clean), path: clean }));
  return profiles.length > 0 ? profiles : [defaultShellProfile(envShell)];
}

export async function probeTerminalEnvironment(
  io: TerminalEnvIo = defaultTerminalEnvIo(),
): Promise<TerminalEnvironment> {
  const ghostty = await loadGhosttyConfig(io.home, io.readText);
  const [externalApps, shells] = await Promise.all([
    detectExternalTerminals(io.home, io.pathExists),
    detectShellProfiles(ghostty.command, io.envShell, io.pathExists),
  ]);
  return { externalApps, shells, ghostty };
}

export const discoverTerminalEnvironment: () => Promise<TerminalEnvironment> = onceAsync(() =>
  probeTerminalEnvironment(),
);

/** A shell's size until the view has measured the terminal. */
const DEFAULT_ROWS = 32;
const DEFAULT_COLS = 140;
/** Lines the test channel's mirror shows (the newest). */
const MIRROR_ROWS = 14;

/** What a tab's shell needs from the pane. */
interface SessionDeps {
  cwd: Accessor<string>;
  app: Accessor<ExternalTerminalApp | undefined>;
  /** The test channel is in use: mirrors are kept current. */
  mirrorOn: Accessor<boolean>;
  /** A tab's shell exited (not one replaced by a new shell). */
  exited: (tab: TermTab) => void;
}

function createTermTab(id: number, initialShell: ShellProfile, deps: SessionDeps): TermTab {
  const shell = signal<ShellProfile>(initialShell);
  const programTitle = signal("");
  const tab: TermTab = {
    id,
    shell,
    programTitle,
    title: computed(() => `${id}: ${programTitle() || shell().name}`),
    session: new TerminalSession(DEFAULT_ROWS, DEFAULT_COLS),
    startedIn: null,
    gate: null,
    typed: false,
    mirror: signal<string[]>([]),
  };
  void listen(tab, deps);
  return tab;
}

/** The screen and scrollback as lines, for the mirror. */
function refreshMirror(tab: TermTab, deps: SessionDeps): void {
  if (!untracked(() => deps.mirrorOn())) return;
  const lines = tab.session.screenText().split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  tab.mirror.set(lines);
}

/** A tab's events, until it closes. */
async function listen(tab: TermTab, deps: SessionDeps): Promise<void> {
  for (;;) {
    const event = await tab.session.nextEvent();
    if (event.kind === "closed") return;
    onSessionEvent(tab, event, deps);
  }
}

function onSessionEvent(tab: TermTab, event: SessionEvent, deps: SessionDeps): void {
  if (event.kind === "output") {
    tab.gate?.output();
    refreshMirror(tab, deps);
  } else if (event.kind === "title") {
    tab.programTitle.set(event.title ?? "");
  } else if (event.kind === "exit") {
    // A late exit of a shell already replaced (new folder or shell) ends nothing.
    if (!tab.session.running) deps.exited(tab);
  } else if (event.kind === "input") {
    // A key in a tab whose shell ended starts a new one.
    startSession(tab, deps);
  }
}

function buildShellStartOptions(tab: TermTab, deps: SessionDeps): ShellOptions {
  const cwd = untracked(() => deps.cwd()) || os.homedir();
  const app = untracked(() => deps.app());
  return {
    shell: untracked(() => tab.shell().path),
    cwd,
    termProgram: app?.termProgram || process.env.TERM_PROGRAM || "Aed",
    resourcesDir: app?.resourcesDir || "",
  };
}

export function createSessionInputGate(
  session: Pick<TerminalSession, "write" | "setNotifyOutput">,
  mirrorOn: Accessor<boolean>,
  schedule?: (fn: () => void, ms: number) => unknown,
  cancel?: (handle: unknown) => void,
): InputGate<Uint8Array> {
  return createInputGate(
    (data: Uint8Array) => session.write(data),
    schedule,
    cancel,
    () => {
      if (!untracked(mirrorOn)) session.setNotifyOutput(false);
    },
  );
}

/** Start a tab's shell (once); a failure shows in the terminal, not as a crash. */
function startSession(tab: TermTab, deps: SessionDeps): void {
  if (tab.session.running) return;
  const options = buildShellStartOptions(tab, deps);
  try {
    tab.session.setNotifyOutput(true);
    tab.session.start(options);
    tab.startedIn = options.cwd;
    tab.typed = false;
    tab.gate = createSessionInputGate(tab.session, deps.mirrorOn);
  } catch (error) {
    tab.session.feed(`[error] ${String(error)}\r\n`);
  }
}

/** Replace a tab's shell with a fresh one, on a clean screen. */
function restartSession(tab: TermTab, deps: SessionDeps): void {
  tab.session.stop();
  tab.session.reset();
  tab.programTitle.set("");
  tab.startedIn = null;
  startSession(tab, deps);
  refreshMirror(tab, deps);
}

/** Whether the user typed into the tab's running shell. */
function typedInto(tab: TermTab): boolean {
  return tab.session.running && (tab.session.used || tab.typed);
}

/**
 * A new default shell (Preferences): tabs nobody has typed into take it,
 * restarting if their old shell runs; used tabs keep theirs.
 */
function adoptShell(tabs: TermTab[], shell: ShellProfile, deps: SessionDeps): void {
  for (const tab of tabs) {
    if (typedInto(tab) || untracked(() => tab.shell().path) === shell.path) continue;
    tab.shell.set(shell);
    if (tab.session.running) restartSession(tab, deps);
  }
}

/** Restart every tab whose shell should follow the open folder (see `shouldFollowCwd`). */
function followFolder(tabs: TermTab[], deps: SessionDeps): void {
  const dir = untracked(() => deps.cwd()) || os.homedir();
  for (const tab of tabs) {
    // `used`, not `typedInto`: a used shell that just ended (its exit not handled yet) keeps its screen.
    const shell =
      tab.startedIn === null
        ? undefined
        : { cwd: tab.startedIn, used: tab.session.used || tab.typed };
    if (shouldFollowCwd(shell, dir)) restartSession(tab, deps);
  }
}

/**
 * Pure target summary for a ⌘-clicked word or OSC 8 hyperlink: external URL or
 * stripped local file path relative to `dir` (preserving `App.test.tsx` shape).
 */
export function linkTarget(
  text: string,
  dir: string,
  home: string,
): { url: string } | { file: string } | null {
  const parsed = parseTarget(text, { baseDir: dir, homeDir: home });
  if (parsed.kind === "external") return { url: parsed.url };
  if (parsed.kind === "candidates") {
    const stripped = parsed.items[parsed.items.length - 1];
    return stripped ? { file: stripped.path } : null;
  }
  if (/^ftp:\/\/\S+$/i.test(text)) return { file: path.resolve(dir, text) };
  return null;
}

export interface TerminalLinkDeps {
  stat: StatFn;
  openExternal: (url: string) => void;
  onFileOpen?: TerminalFileOpenHandler;
}

function invokeFileOpen(
  onFileOpen: TerminalFileOpenHandler | undefined,
  filePath: string,
  line: number,
  column: number,
): void {
  if (!onFileOpen) return;
  const openWithLoc = onFileOpen as (
    targetPath: string,
    location?: TerminalFileLocation,
  ) => unknown;
  if (line > 0) {
    openWithLoc(filePath, { line, column: column > 0 ? column : 1 });
  } else {
    openWithLoc(filePath);
  }
}

/**
 * Resolve a terminal ⌘-click or OSC 8 hyperlink (`src/a.ts:12:3`, `src/a.ts#L12`,
 * `~/foo.ts:9`, `file:///Users/.../a.ts#L5`, `https://...`) via `resolveTarget`.
 */
export async function openTerminalLink(
  raw: string,
  opts: TargetOptions,
  deps: TerminalLinkDeps,
): Promise<void> {
  const resolved = await resolveTarget(raw, opts, deps.stat);
  if (!resolved) return;
  if (resolved.kind === "external") {
    deps.openExternal(resolved.url);
    return;
  }
  if (!resolved.isDirectory) {
    invokeFileOpen(deps.onFileOpen, resolved.path, resolved.line, resolved.column);
  }
}

function openLink(
  text: string,
  tab: TermTab,
  cwd: string,
  onFileOpen?: TerminalFileOpenHandler,
): Promise<void> {
  const baseDir = tab.startedIn ?? (cwd || os.homedir());
  return openTerminalLink(
    text,
    { baseDir, homeDir: os.homedir() },
    {
      stat: (candidatePath) => statDisk(candidatePath),
      openExternal: (url) => void openUrl(url),
      onFileOpen,
    },
  );
}

function resolveShellByPath(
  list: ShellProfile[],
  targetPath: string | undefined,
  fallback: ShellProfile,
): ShellProfile {
  if (!targetPath) return list[0] || fallback;
  const matched = list.find((s) => s.path === targetPath || s.name === targetPath);
  if (matched) return matched;
  return { name: path.basename(targetPath) || "shell", path: targetPath };
}

export function ShellSelectOptionRow(props: {
  value: string;
  title: string;
  selected: boolean;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const shellName = props.value.split("/").pop() || props.title;
  return (
    <View
      testID={`shell-option-${shellName}`}
      style={props.selected ? { backgroundColor: props.theme().ui.selection } : undefined}
      class="h-7 px-3 rounded flex-row items-center justify-between gap-2 select-none group-focus:bg-foreground/10"
    >
      <View class="flex-row items-center gap-2 min-w-0 flex-1">
        <Text
          style={{ color: props.theme().ui.foreground }}
          class={`text-xs font-mono shrink-0 ${props.selected ? "font-medium" : "font-normal"}`}
        >
          {shellName}
        </Text>
        <Text
          style={{ color: props.theme().ui.mutedForeground }}
          class="text-[11px] font-mono truncate"
        >
          {props.value}
        </Text>
      </View>
      <View class="w-4 items-center justify-center shrink-0">
        <If when={props.selected}>
          <Icon name="check" size={12} tint={() => props.theme().ui.accent} />
        </If>
      </View>
    </View>
  );
}

/** A pane's state, shared by the functions below and its component. */
interface TerminalModel {
  tabs: Signal<TermTab[]>;
  activeId: Signal<number>;
  selectedShell: Signal<ShellProfile>;
  /** The native view, once mounted. */
  view: NativeComponentRef | null;
  /** Whether the terminal has the keyboard (the view says so). */
  focused: Signal<boolean>;
  /** The test channel is in use: the plain-text mirror is fed and shown. */
  mirrorOn: Signal<boolean>;
  /** Whether the panel shows: shells start only then. */
  visible: Accessor<boolean>;
  /** The last tab's shell exited: the panel closes. */
  onEmpty: () => void;
  nextId: () => number;
  deps: SessionDeps;
}

function activeTabOf(model: TerminalModel): TermTab {
  const list = untracked(() => model.tabs());
  const id = untracked(() => model.activeId());
  return list.find((tab) => tab.id === id) ?? list[0];
}

function createTerminalModel(
  firstShell: ShellProfile,
  selectedShell: Signal<ShellProfile>,
  cwd: Accessor<string>,
  app: Accessor<ExternalTerminalApp | undefined>,
  visible: Accessor<boolean>,
  onEmpty: () => void,
): TerminalModel {
  let counter = 1;
  const mirrorOn = signal(false);
  const deps: SessionDeps = { cwd, app, mirrorOn, exited: (tab) => shellExited(model, tab.id) };
  const firstTab = createTermTab(counter, firstShell, deps);
  const model: TerminalModel = {
    tabs: signal<TermTab[]>([firstTab]),
    activeId: signal(firstTab.id),
    selectedShell,
    view: null,
    focused: signal(false),
    mirrorOn,
    visible,
    onEmpty,
    nextId: () => ++counter,
    deps,
  };
  return model;
}

function focusTerminal(model: TerminalModel): void {
  model.view?.command("focus");
}

/** ⌘K while the terminal has the keyboard. */
function clearActive(model: TerminalModel): void {
  const tab = activeTabOf(model);
  tab.session.clear();
  refreshMirror(tab, model.deps);
}

/** A new active tab; its shell starts (and it takes the keyboard) if the panel shows. */
function addTab(model: TerminalModel, shell: ShellProfile): void {
  const tab = createTermTab(model.nextId(), shell, model.deps);
  model.tabs.update((previous) => previous.concat([tab]));
  model.activeId.set(tab.id);
  if (!untracked(() => model.visible())) return;
  startSession(tab, model.deps);
  focusTerminal(model);
}

/** Close a tab and its shell; the last tab is replaced first (never no tab). */
function closeTab(model: TerminalModel, id: number): void {
  if (untracked(() => model.tabs()).length === 1) {
    addTab(model, untracked(() => model.selectedShell()));
  }
  untracked(() => model.tabs())
    .find((tab) => tab.id === id)
    ?.session.close();
  model.tabs.update((list) => list.filter((tab) => tab.id !== id));
  if (untracked(() => model.activeId()) !== id) return;
  const remaining = untracked(() => model.tabs());
  model.activeId.set(remaining[remaining.length - 1].id);
  focusTerminal(model);
}

/**
 * A shell exited (Ctrl+D, `exit`): its tab closes, as in Ghostty. The last
 * tab's closing also closes the panel; its new tab starts when it shows.
 */
function shellExited(model: TerminalModel, id: number): void {
  if (untracked(() => model.tabs()).length === 1) model.onEmpty();
  closeTab(model, id);
}

/**
 * The user picked a shell in the dropdown: it becomes the default for new
 * tabs; the active tab switches to it unless someone typed into it, then
 * the shell opens in a new tab instead (a used session is never killed).
 */
function pickShell(model: TerminalModel, shell: ShellProfile): void {
  model.selectedShell.set(shell);
  const tab = activeTabOf(model);
  if (typedInto(tab)) {
    addTab(model, shell);
    return;
  }
  tab.shell.set(shell);
  restartSession(tab, model.deps);
  focusTerminal(model);
}

/** Test-channel input as bytes: `binary` gives one byte per character. */
function inputBytes(data: string, binary: boolean): Uint8Array {
  return binary
    ? Uint8Array.from(data, (c) => c.charCodeAt(0))
    : new TextEncoder().encode(data);
}

function enableTestMirror(model: TerminalModel): void {
  if (untracked(() => model.mirrorOn())) return;
  model.mirrorOn.set(true);
  for (const tab of untracked(() => model.tabs())) {
    tab.session.setNotifyOutput(true);
    refreshMirror(tab, model.deps);
  }
}

/**
 * Test channel; the packaged app's host never sends it. `aed.terminal.test`
 * does what the native view would for the active tab (headless tests have
 * none): `input` (typed keys, through the start-up gate), `resize` and
 * `focus`; and it turns on the plain-text mirror (`id:terminal-mirror`) that
 * tests read.
 */
function onTestMessage(model: TerminalModel, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  enableTestMirror(model);
  const msg = data as Record<string, unknown>;
  TEST_MESSAGES[String(msg.type)]?.(model, activeTabOf(model), msg);
}

const TEST_MESSAGES: Record<
  string,
  (model: TerminalModel, tab: TermTab, msg: Record<string, unknown>) => void
> = {
  input: (model, tab, msg) => {
    if (typeof msg.data !== "string") return;
    startSession(tab, model.deps);
    tab.typed = true;
    tab.gate?.send(inputBytes(msg.data, msg.binary === true));
  },
  resize: (_model, tab, msg) => {
    if (typeof msg.rows === "number" && typeof msg.cols === "number") {
      tab.session.resize(msg.rows, msg.cols);
    }
  },
  focus: (model, _tab, msg) => {
    if (typeof msg.focused === "boolean") model.focused.set(msg.focused);
  },
};

interface KnownEnvironmentSignals {
  shells: Signal<ShellProfile[]>;
  selectedShell: Signal<ShellProfile>;
  externalApps: Signal<ExternalTerminalApp[]>;
  ghosttyCfg: Signal<GhosttyConfig>;
}

/** What `discoverTerminalEnvironment` found, into the pane's signals; the preferred shell is selected. */
function applyEnvironment(
  env: TerminalEnvironment,
  known: KnownEnvironmentSignals,
  preferred: string | undefined,
  fallback: ShellProfile,
): void {
  if (env.shells.length > 0) {
    known.shells.set(env.shells);
    known.selectedShell.set(resolveShellByPath(env.shells, preferred, fallback));
  }
  if (env.externalApps.length > 0) known.externalApps.set(env.externalApps);
  known.ghosttyCfg.set(env.ghostty);
}

/** The panel shows: every tab's shell starts (once), and the terminal takes the keyboard. */
function startShown(model: TerminalModel): void {
  for (const tab of untracked(() => model.tabs())) startSession(tab, model.deps);
  focusTerminal(model);
}

/** The terminal font: Preferences first, then Ghostty's config, then 12 pt. */
function terminalFont(
  props: TerminalPaneProps,
  cfg: GhosttyConfig,
): { fontFamily?: string; fontSize: number } {
  const family = props.fontFamily?.() || cfg.fontFamily || undefined;
  const fallbackSize = cfg.fontSize ? Math.round(cfg.fontSize) : 12;
  return { fontFamily: family, fontSize: props.fontSize?.() ?? fallbackSize };
}

/** Tabs, the new-tab button and the shell dropdown. */
function TerminalToolbar(props: {
  model: TerminalModel;
  theme: Accessor<EditorTheme>;
  activeTab: Accessor<TermTab>;
  shellItems: Accessor<SelectItem[]>;
  onPick: (shellPath: string | undefined) => void;
}): JSX.Element {
  return (
    <TabStrip
      heightClass="h-8"
      mono
      items={props.model.tabs()}
      activeId={props.model.activeId()}
      getId={(tab) => tab.id}
      getLabel={(tab) => tab.title()}
      getTestKey={(tab) => tab.id}
      selectTestIdPrefix="terminal-tab"
      closeTestIdPrefix="terminal-tab-close"
      onSelect={(id) => {
        props.model.activeId.set(Number(id));
        focusTerminal(props.model);
      }}
      onClose={(id) => closeTab(props.model, Number(id))}
      trailing={
        <View class="flex-row items-center gap-1.5 px-2 shrink-0">
          <IconButton
            icon="plus"
            iconSize={12}
            testID="terminal-add-btn"
            accessibilityLabel="New terminal tab"
            onPress={() => addTab(props.model, props.model.selectedShell())}
          />
          <Select
            testID="terminal-shell-select"
            accessibilityLabel="Select shell"
            items={props.shellItems()}
            value={props.activeTab().shell().path}
            placement="top"
            align="end"
            offset={6}
            onChange={({ value }) => props.onPick(value || undefined)}
            trigger={
              <View
                testID="terminal-shell-trigger"
                style={{ backgroundColor: props.theme().ui.background }}
                class="h-6 px-2 flex-row items-center gap-1.5 rounded"
              >
                <Text style={{ color: props.theme().ui.foreground }} class="text-[11px] font-mono">
                  {props.activeTab().shell().name}
                </Text>
                <Icon
                  name="chevron-down"
                  size={10}
                  tint={() => props.theme().ui.mutedForeground}
                />
              </View>
            }
            popupClass="w-56 rounded-lg shadow-2xl p-1"
            popupStyle={{ backgroundColor: props.theme().ui.card }}
            itemClass="group rounded"
            renderItem={(item) => (
              <ShellSelectOptionRow
                value={item.value}
                title={item.title}
                selected={item.value === props.activeTab().shell().path}
                theme={props.theme}
              />
            )}
          />
        </View>
      }
      class="border-b border-border"
    />
  );
}

/** The native terminal view (native/src/view.rs). */
const Terminal = nativeComponent<
  { session: number; fontFamily?: string; fontSize: number; theme: TerminalTheme },
  { focused: { focused: boolean }; link: { text: string } }
>("aed.terminal", {
  props: ["session", "fontFamily", "fontSize", "theme"],
  events: ["focused", "link"],
});

function bindTerminalLifecycleEffects(
  model: TerminalModel,
  known: KnownEnvironmentSignals,
  props: TerminalPaneProps,
  fallbackShell: ShellProfile,
): void {
  cleanup(host.on("aed.terminal.test", (data) => onTestMessage(model, data)));

  effect(() => {
    void discoverTerminalEnvironment().then((env) => {
      applyEnvironment(env, known, untracked(() => props.shellPath?.()), fallbackShell);
    });
  });

  // A new default shell from Preferences: unused tabs take it.
  effect(() => {
    const extPath = props.shellPath?.();
    if (!extPath) return;
    const resolved = resolveShellByPath(untracked(() => known.shells()), extPath, fallbackShell);
    known.selectedShell.set(resolved);
    deferOutOfEffect(() => adoptShell(untracked(() => model.tabs()), resolved, model.deps));
  });

  // Shells start the first time the panel shows (outside effect pass: DESIGN.md trap #8).
  effect(() => {
    if (!props.visible()) {
      model.focused.set(false);
      return;
    }
    deferOutOfEffect(() => startShown(model));
  });
}

function bindTerminalFolderAndKeyEffects(model: TerminalModel, props: TerminalPaneProps): void {
  effect(() => {
    cleanup(() => {
      for (const tab of untracked(() => model.tabs())) tab.session.close();
    });
  });

  effect(() => {
    void props.cwd();
    deferOutOfEffect(() => followFolder(untracked(() => model.tabs()), model.deps));
  });

  // While the terminal has the keyboard its bindings win: ⌘K clears, ⌘F suppresses find bar.
  effect(() => {
    if (!model.focused()) return;
    cleanup(keymap.bind({ "mod+k": () => clearActive(model), "mod+f": () => undefined }));
  });
}

/**
 * A bottom-dock terminal: a libghostty-vt terminal per tab, drawn by a
 * native view; discovers local terminal apps (Ghostty, iTerm2, Warp, kitty,
 * WezTerm, Alacritty, Terminal) and installed shells, and applies local
 * Ghostty font settings.
 */
export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const fallbackShell = defaultShellProfile();
  const shells = signal<ShellProfile[]>([fallbackShell]);
  const selectedShell = signal<ShellProfile>(
    resolveShellByPath([fallbackShell], untracked(() => props.shellPath?.()), fallbackShell),
  );
  const externalApps = signal<ExternalTerminalApp[]>([]);
  const ghosttyCfg = signal<GhosttyConfig>({});
  const primaryExternal = computed(() => externalApps()[0]);
  const model = createTerminalModel(
    untracked(() => selectedShell()),
    selectedShell,
    props.cwd,
    primaryExternal,
    props.visible,
    () => props.onEmpty?.(),
  );

  const activeTab = computed(
    () => model.tabs().find((tab) => tab.id === model.activeId()) ?? model.tabs()[0],
  );
  const activeTheme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);
  const font = computed(() => terminalFont(props, ghosttyCfg()));
  const termTheme = computed(() => buildTerminalTheme(activeTheme()));
  const shellItems = computed<SelectItem[]>(() =>
    shells().map((s) => ({ value: s.path, title: s.name, subtitle: s.path })),
  );

  bindTerminalLifecycleEffects(
    model,
    { shells, selectedShell, externalApps, ghosttyCfg },
    props,
    fallbackShell,
  );
  bindTerminalFolderAndKeyEffects(model, props);

  return (
    <View
      style={{ backgroundColor: activeTheme().ui.sidebar }}
      class="flex-1 flex-col"
      testID="terminal-pane"
    >
      <TerminalToolbar
        model={model}
        theme={activeTheme}
        activeTab={activeTab}
        shellItems={shellItems}
        onPick={(value) => {
          const shell = resolveShellByPath(shells(), value, fallbackShell);
          props.onShellChange?.(shell.path);
          pickShell(model, shell);
        }}
      />

      <View style={{ backgroundColor: activeTheme().ui.background }} class="flex-1">
        <Terminal
          ref={(view: NativeComponentRef) => {
            model.view = view;
          }}
          testID="terminal-view"
          class="flex-1"
          session={activeTab().session.id}
          fontFamily={font().fontFamily}
          fontSize={font().fontSize}
          theme={termTheme()}
          onFocused={(event: { focused: boolean }) => model.focused.set(event.focused)}
          onLink={(event: { text: string }) =>
            void openLink(
              event.text,
              untracked(() => activeTab()),
              untracked(() => props.cwd()),
              props.onFileOpen,
            )
          }
        />
        <If when={model.mirrorOn()}>
          <View testID="terminal-mirror" class="absolute inset-0 flex-col overflow-hidden">
            <Each of={activeTab().mirror().slice(-MIRROR_ROWS)} key="index">
              {(line) => (
                <Text
                  style={{ color: activeTheme().ui.foreground }}
                  class="font-mono text-[8px] leading-none line-clamp-1"
                >
                  {line()}
                </Text>
              )}
            </Each>
          </View>
        </If>
      </View>
    </View>
  );
}
