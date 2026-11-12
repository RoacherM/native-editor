import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import process from "process";
import { type SessionEvent, TerminalSession } from "aed/native";
import type { Accessor, JSX, NativeComponentRef, Signal } from "nsh";
import {
  cleanup,
  computed,
  effect,
  host,
  keymap,
  nativeComponent,
  openUrl,
  Scroll,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import { Button, Select, type SelectItem } from "nsh/base";
import { Icon } from "./icons";
import { buildTerminalTheme, type TerminalTheme } from "./terminalTheme";
import { EDITOR_THEMES, type EditorTheme } from "./themes";

// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」. The terminal's tabs: a
// `TerminalSession` each (libghostty-vt and the shell on its PTY, native/),
// the native `aed.terminal` view that shows the active one, and the test
// channel.

export interface TerminalPaneProps {
  cwd: Accessor<string>;
  /** Whether the panel is shown; shells start the first time it is (none at launch). */
  visible: Accessor<boolean>;
  fontFamily?: Accessor<string>;
  fontSize?: Accessor<number>;
  shellPath?: Accessor<string>;
  theme?: Accessor<EditorTheme>;
  onShellChange?: (shellPath: string) => void;
  onFileOpen?: (filePath: string) => void;
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
 * SHELL_READY_MAX_MS passed. `schedule` / `cancel` are injectable for tests.
 * Opening again is harmless: the queue is already empty.
 */
export function createInputGate<T>(
  write: (data: T) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
): InputGate<T> {
  let ready = false;
  let quiet: unknown;
  const queued: T[] = [];
  const open = () => {
    ready = true;
    cancel(quiet);
    cancel(fallback);
    for (const data of queued.splice(0)) write(data);
  };
  // A shell that stays silent still gets its input.
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
export function shouldFollowCwd(session: { cwd: string; used: boolean } | undefined, cwd: string): boolean {
  return !!session && !session.used && session.cwd !== cwd;
}

const TERMINAL_APP_CANDIDATES: {
  id: string;
  name: string;
  relBundle: string;
  termProgram: string;
  resourcesSubpath?: string;
}[] = [
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function applyGhosttyConfigEntry(
  cfg: GhosttyConfig,
  key: string,
  val: string
): void {
  if (key === "font-family" && !cfg.fontFamily) cfg.fontFamily = val;
  else if (key === "font-size") {
    const n = Number(val);
    if (!Number.isNaN(n) && n >= 9 && n <= 28) cfg.fontSize = n;
  } else if (key === "theme") cfg.theme = val;
  else if (key === "cursor-color") cfg.cursorColor = val;
  else if (key === "command") cfg.command = val;
}

/** Parse Ghostty's key = value config text. */
export function parseGhosttyConfig(raw: string): GhosttyConfig {
  const cfg: GhosttyConfig = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (val) applyGhosttyConfigEntry(cfg, key, val);
  }
  return cfg;
}

async function loadGhosttyConfig(home: string): Promise<GhosttyConfig> {
  const paths = [
    path.join(home, ".config/ghostty/config.ghostty"),
    path.join(home, ".config/ghostty/config"),
    path.join(
      home,
      "Library/Application Support/com.mitchellh.ghostty/config.ghostty"
    ),
    path.join(home, "Library/Application Support/com.mitchellh.ghostty/config"),
  ];
  let merged: GhosttyConfig = {};
  for (const p of paths) {
    try {
      const bytes = await fs.readFile(p);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      merged = { ...merged, ...parseGhosttyConfig(text) };
    } catch {
      // Config file not present at this path
    }
  }
  return merged;
}

async function detectExternalTerminals(
  home: string
): Promise<ExternalTerminalApp[]> {
  const appDirs = ["/Applications", path.join(home, "Applications")];
  const found: ExternalTerminalApp[] = [];
  for (const cand of TERMINAL_APP_CANDIDATES) {
    for (const dir of appDirs) {
      const bundlePath = path.join(dir, cand.relBundle);
      if (await pathExists(bundlePath)) {
        found.push({
          id: cand.id,
          name: cand.name,
          bundlePath,
          termProgram: cand.termProgram,
          resourcesDir: cand.resourcesSubpath
            ? path.join(bundlePath, cand.resourcesSubpath)
            : undefined,
        });
        break;
      }
    }
  }
  const sysTerm = "/System/Applications/Utilities/Terminal.app";
  if (await pathExists(sysTerm)) {
    found.push({
      id: "apple-terminal",
      name: "Terminal",
      bundlePath: sysTerm,
      termProgram: "Apple_Terminal",
    });
  }
  return found;
}

function defaultShellProfile(): ShellProfile {
  const envShell = process.env.SHELL || "/bin/zsh";
  return { name: path.basename(envShell) || "shell", path: envShell };
}

async function detectShellProfiles(
  ghosttyCommand?: string
): Promise<ShellProfile[]> {
  const seen = new Set<string>();
  const profiles: ShellProfile[] = [];
  const addIfValid = async (shellPath: string | undefined) => {
    if (!shellPath) return;
    const clean = shellPath.trim().split(/\s+/)[0];
    if (!clean || seen.has(clean)) return;
    if (await pathExists(clean)) {
      seen.add(clean);
      profiles.push({ name: path.basename(clean), path: clean });
    }
  };
  await addIfValid(ghosttyCommand);
  await addIfValid(process.env.SHELL);
  for (const cand of SHELL_CANDIDATES) {
    await addIfValid(cand);
  }
  return profiles.length > 0 ? profiles : [defaultShellProfile()];
}

export async function discoverTerminalEnvironment(): Promise<TerminalEnvironment> {
  const home = os.homedir();
  const ghostty = await loadGhosttyConfig(home);
  const [externalApps, shells] = await Promise.all([
    detectExternalTerminals(home),
    detectShellProfiles(ghostty.command),
  ]);
  return { externalApps, shells, ghostty };
}

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
    endSession(tab, event.code, deps);
  } else if (event.kind === "input") {
    // A key in a tab whose shell ended starts a new one.
    startSession(tab, deps);
  }
}

/**
 * The shell exited: its screen stays, with a line saying so. A late exit of
 * a shell already replaced (new folder or shell) ends nothing.
 */
function endSession(tab: TermTab, code: number | null | undefined, deps: SessionDeps): void {
  if (tab.session.running) return;
  tab.startedIn = null;
  tab.gate = null;
  const status = code === null || code === undefined ? "" : ` (exit ${code})`;
  tab.session.feed(`\r\n[${untracked(() => tab.title())}] session ended${status}\r\n`);
  refreshMirror(tab, deps);
}

/** Start a tab's shell (once); a failure shows in the terminal, not as a crash. */
function startSession(tab: TermTab, deps: SessionDeps): void {
  if (tab.session.running) return;
  const cwd = untracked(() => deps.cwd()) || os.homedir();
  const app = untracked(() => deps.app());
  try {
    tab.session.start({
      shell: untracked(() => tab.shell().path),
      cwd,
      termProgram: app?.termProgram || process.env.TERM_PROGRAM || "Aed",
      resourcesDir: app?.resourcesDir || "",
    });
    tab.startedIn = cwd;
    tab.typed = false;
    tab.gate = createInputGate((data: Uint8Array) => tab.session.write(data));
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
    const shell = tab.startedIn === null ? undefined : { cwd: tab.startedIn, used: tab.session.used || tab.typed };
    if (shouldFollowCwd(shell, dir)) restartSession(tab, deps);
  }
}

/**
 * What a ⌘-clicked word opens: a web link, or a file (`src/a.ts:12:3`, its
 * line and column dropped) relative to `dir`, the shell's start directory.
 */
export function linkTarget(text: string, dir: string, home: string): { url: string } | { file: string } | null {
  if (/^https?:\/\/\S+$/i.test(text)) return { url: text };
  const file = text.replace(/:\d+(:\d+)?$/, "").replace(/^~(?=\/|$)/, home);
  return file ? { file: path.resolve(dir, file) } : null;
}

/**
 * ⌘-click in the terminal: a web link opens in the browser, an existing file
 * in a tab. Paths are relative to where the tab's shell started (else `cwd`).
 */
async function openLink(text: string, tab: TermTab, cwd: string, onFileOpen?: (filePath: string) => void): Promise<void> {
  const target = linkTarget(text, tab.startedIn ?? (cwd || os.homedir()), os.homedir());
  if (!target) return;
  if ("url" in target) {
    void openUrl(target.url);
    return;
  }
  try {
    if ((await fs.stat(target.file)).isFile()) onFileOpen?.(target.file);
  } catch {
    // Not a file: the word was not a path.
  }
}

function resolveShellByPath(
  list: ShellProfile[],
  targetPath: string | undefined,
  fallback: ShellProfile
): ShellProfile {
  if (!targetPath) return list[0] || fallback;
  const matched = list.find(
    (s) => s.path === targetPath || s.name === targetPath
  );
  if (matched) return matched;
  return { name: path.basename(targetPath) || "shell", path: targetPath };
}

function TermTabChip(props: {
  tab: Accessor<TermTab>;
  activeId: Accessor<number>;
  theme: Accessor<EditorTheme>;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
}): JSX.Element {
  const isActive = computed(() => props.tab().id === props.activeId());
  return (
    <View
      style={{
        backgroundColor: isActive()
          ? props.theme().ui.background
          : "transparent",
      }}
      class="h-8 px-3 flex-row items-center gap-2 shrink-0 select-none"
    >
      <If when={isActive()}>
        <View
          style={{ backgroundColor: props.theme().ui.accent }}
          class="absolute left-0 right-0 top-0 h-[2px]"
        />
      </If>
      <View onPress={() => props.onSelect(props.tab().id)} role="button">
        <Text
          style={{
            color: isActive()
              ? props.theme().ui.foreground
              : props.theme().ui.mutedForeground,
          }}
          class={`text-xs font-mono ${
            isActive() ? "font-medium" : "font-normal"
          }`}
        >
          {props.tab().title()}
        </Text>
      </View>
      <View
        onPress={() => props.onClose(props.tab().id)}
        role="button"
        class="h-4 w-4 items-center justify-center rounded"
      >
        <Icon
          name="close"
          size={10}
          tint={() => props.theme().ui.mutedForeground}
        />
      </View>
    </View>
  );
}

function ShellSelectOptionRow(props: {
  value: string;
  title: string;
  selected: boolean;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const shellName = props.value.split("/").pop() || props.title;
  return (
    <View
      testID={`shell-option-${shellName}`}
      style={{
        backgroundColor: props.selected
          ? props.theme().ui.selection
          : "transparent",
      }}
      class="h-7 px-3 rounded flex-row items-center justify-between gap-2 select-none"
    >
      <View class="flex-row items-center gap-2 min-w-0 flex-1">
        <Text
          style={{ color: props.theme().ui.foreground }}
          class={`text-xs font-mono shrink-0 ${
            props.selected ? "font-medium" : "font-normal"
          }`}
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
          <Icon
            name="check"
            size={12}
            tint={() => props.theme().ui.accent}
          />
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
  app: Accessor<ExternalTerminalApp | undefined>
): TerminalModel {
  let counter = 1;
  const mirrorOn = signal(false);
  const deps: SessionDeps = { cwd, app, mirrorOn };
  const firstTab = createTermTab(counter, firstShell, deps);
  return {
    tabs: signal<TermTab[]>([firstTab]),
    activeId: signal(firstTab.id),
    selectedShell,
    view: null,
    focused: signal(false),
    mirrorOn,
    nextId: () => ++counter,
    deps,
  };
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

function addTab(model: TerminalModel, shell: ShellProfile): void {
  const tab = createTermTab(model.nextId(), shell, model.deps);
  model.tabs.update((previous) => previous.concat([tab]));
  model.activeId.set(tab.id);
  startSession(tab, model.deps);
  focusTerminal(model);
}

/** Close a tab and its shell; the last tab closing opens a new one at once. */
function closeTab(model: TerminalModel, id: number): void {
  const all = untracked(() => model.tabs());
  all.find((tab) => tab.id === id)?.session.close();
  const remaining = all.filter((tab) => tab.id !== id);
  model.tabs.set(remaining);
  if (untracked(() => model.activeId()) !== id) return;
  if (remaining.length === 0) {
    addTab(model, untracked(() => model.selectedShell()));
    return;
  }
  model.activeId.set(remaining[remaining.length - 1].id);
  focusTerminal(model);
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
  return binary ? Uint8Array.from(data, (c) => c.charCodeAt(0)) : new TextEncoder().encode(data);
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
  if (!untracked(() => model.mirrorOn())) {
    model.mirrorOn.set(true);
    for (const tab of untracked(() => model.tabs())) refreshMirror(tab, model.deps);
  }
  const msg = data as Record<string, unknown>;
  TEST_MESSAGES[String(msg.type)]?.(model, activeTabOf(model), msg);
}

const TEST_MESSAGES: Record<string, (model: TerminalModel, tab: TermTab, msg: Record<string, unknown>) => void> = {
  input: (model, tab, msg) => {
    if (typeof msg.data !== "string") return;
    startSession(tab, model.deps);
    tab.typed = true;
    tab.gate?.send(inputBytes(msg.data, msg.binary === true));
  },
  resize: (_model, tab, msg) => {
    if (typeof msg.rows === "number" && typeof msg.cols === "number") tab.session.resize(msg.rows, msg.cols);
  },
  focus: (model, _tab, msg) => {
    if (typeof msg.focused === "boolean") model.focused.set(msg.focused);
  },
};

/** What `discoverTerminalEnvironment` found, into the pane's signals; the preferred shell is selected. */
function applyEnvironment(
  env: TerminalEnvironment,
  known: {
    shells: Signal<ShellProfile[]>;
    selectedShell: Signal<ShellProfile>;
    externalApps: Signal<ExternalTerminalApp[]>;
    ghosttyCfg: Signal<GhosttyConfig>;
  },
  preferred: string | undefined,
  fallback: ShellProfile
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
function terminalFont(props: TerminalPaneProps, cfg: GhosttyConfig): { fontFamily?: string; fontSize: number } {
  const family = props.fontFamily?.() || cfg.fontFamily || undefined;
  const size = props.fontSize?.() ?? (cfg.fontSize ? Math.round(cfg.fontSize) : 12);
  return { fontFamily: family, fontSize: size };
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
    <View
      style={{ backgroundColor: props.theme().ui.sidebar }}
      class="h-8 pr-3 flex-row items-center justify-between gap-2 shrink-0 select-none"
    >
      <View class="flex-1 flex-row items-center gap-1 min-w-0 overflow-hidden">
        <Scroll horizontal class="flex-initial">
          <View class="flex-row items-stretch h-8">
            <Each of={props.model.tabs()} key={(tab) => tab.id}>
              {(tab) => (
                <TermTabChip
                  tab={tab}
                  activeId={props.model.activeId}
                  theme={props.theme}
                  onSelect={(id) => {
                    props.model.activeId.set(id);
                    focusTerminal(props.model);
                  }}
                  onClose={(id) => closeTab(props.model, id)}
                />
              )}
            </Each>
          </View>
        </Scroll>
        <Button
          testID="terminal-add-btn"
          onPress={() => addTab(props.model, props.model.selectedShell())}
          accessibilityLabel="New terminal tab"
          class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0 shrink-0"
        >
          <Icon name="plus" size={12} tint={() => props.theme().ui.mutedForeground} />
        </Button>
      </View>

      <View class="flex-row items-center shrink-0">
        <Select
          testID="terminal-shell-select"
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
              <Icon name="chevron-down" size={10} tint={() => props.theme().ui.mutedForeground} />
            </View>
          }
          popupClass="w-56 rounded-lg shadow-2xl p-1"
          popupStyle={{ backgroundColor: props.theme().ui.card }}
          itemClass="rounded cursor-pointer"
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
    </View>
  );
}

/** The native terminal view (native/src/view.rs). */
const Terminal = nativeComponent<
  { session: number; fontFamily?: string; fontSize: number; theme: TerminalTheme },
  { focused: { focused: boolean }; link: { text: string } }
>("aed.terminal", { props: ["session", "fontFamily", "fontSize", "theme"], events: ["focused", "link"] });

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
    resolveShellByPath([fallbackShell], untracked(() => props.shellPath?.()), fallbackShell)
  );
  const externalApps = signal<ExternalTerminalApp[]>([]);
  const ghosttyCfg = signal<GhosttyConfig>({});
  const primaryExternal = computed(() => externalApps()[0]);
  const model = createTerminalModel(untracked(() => selectedShell()), selectedShell, props.cwd, primaryExternal);
  const { tabs, activeId, focused, mirrorOn } = model;

  const activeTab = computed(() => tabs().find((tab) => tab.id === activeId()) ?? tabs()[0]);
  const activeTheme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);
  const font = computed(() => terminalFont(props, ghosttyCfg()));
  const termTheme = computed(() => buildTerminalTheme(activeTheme()));

  host.on("aed.terminal.test", (data) => onTestMessage(model, data));

  effect(() => {
    discoverTerminalEnvironment().then((env) => {
      const known = { shells, selectedShell, externalApps, ghosttyCfg };
      applyEnvironment(env, known, untracked(() => props.shellPath?.()), fallbackShell);
    });
  });

  // A new default shell from Preferences: unused tabs take it.
  effect(() => {
    const extPath = props.shellPath?.();
    if (!extPath) return;
    const resolved = resolveShellByPath(untracked(() => shells()), extPath, fallbackShell);
    selectedShell.set(resolved);
    setTimeout(() => adoptShell(untracked(() => tabs()), resolved, model.deps), 0);
  });

  // Shells start the first time the panel shows (no hidden login shell at
  // launch), outside the effect's run (DESIGN.md trap #8).
  effect(() => {
    if (!props.visible()) {
      focused.set(false);
      return;
    }
    setTimeout(() => startShown(model), 0);
  });
  effect(() => {
    cleanup(() => {
      for (const tab of untracked(() => tabs())) tab.session.close();
    });
  });

  effect(() => {
    void props.cwd();
    setTimeout(() => followFolder(untracked(() => tabs()), model.deps), 0);
  });

  // While the terminal has the keyboard its bindings are the newest, so they
  // win: ⌘K clears it (not Quick Open), ⌘F opens no editor find bar.
  effect(() => {
    if (!focused()) return;
    cleanup(keymap.bind({ "mod+k": () => clearActive(model), "mod+f": () => undefined }));
  });

  const shellItems = computed<SelectItem[]>(() =>
    shells().map((s) => ({ value: s.path, title: s.name, subtitle: s.path }))
  );

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
          onFocused={(event: { focused: boolean }) => focused.set(event.focused)}
          onLink={(event: { text: string }) =>
            void openLink(event.text, untracked(() => activeTab()), untracked(() => props.cwd()), props.onFileOpen)
          }
        />
        <If when={mirrorOn()}>
          <View testID="terminal-mirror" class="absolute inset-0 flex-col overflow-hidden">
            {/* The newest lines, one row each, so all of them stay on screen for `app.texts()`. */}
            <Each of={activeTab().mirror().slice(-MIRROR_ROWS)} key="index">
              {(line) => (
                <Text style={{ color: activeTheme().ui.foreground }} class="font-mono text-[8px] leading-none line-clamp-1">
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
