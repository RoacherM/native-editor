import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import process from "process";
import type { ChildProcess } from "process";
import type { Accessor, JSX, Signal, WebViewRef } from "nsh";
import {
  cleanup,
  computed,
  effect,
  host,
  keymap,
  openUrl,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  WebView,
} from "nsh";
import { Button, Select, type SelectItem } from "nsh/base";
import { Icon } from "./icons";
import {
  binaryStringBytes,
  buildTerminalOptions,
  buildTerminalShellHtml,
  createLineSplitter,
  createOutputHistory,
  createTextMirror,
  createUtf8Stream,
  decodeBase64,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  encodeInputFrame,
  encodeResizeFrame,
  isTerminalReport,
  type LineSplitter,
  type OutputHistory,
  pageCall,
  parseBridgeLine,
  parseTerminalPageMessage,
  PTY_BRIDGE_PY,
  type TerminalPageMessage,
  type TextMirror,
  textChunk,
  type Utf8Stream,
} from "./terminalPage";
import { EDITOR_THEMES, type EditorTheme } from "./themes";
import { XTERM_RUNTIME_JS } from "./xtermVendor.generated";

// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」. The I/O shell of the
// terminal: PTY bridge processes, the xterm WebView and the test channel.
// The protocol itself is src/terminalPage.ts.

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

interface TermSize {
  rows: number;
  cols: number;
}

/** The test channel's plain-text copy of a tab's output (fed only once the channel is used). */
interface TabMirror {
  text: TextMirror;
  utf8: Utf8Stream;
  lines: Signal<string[]>;
}

interface TermTab {
  id: number;
  shell: Signal<ShellProfile>;
  /** The title the program set (OSC 0/2), "" for none. */
  programTitle: Signal<string>;
  title: Accessor<string>;
  /** What the page shows; replayed when the page becomes ready. */
  history: OutputHistory;
  mirror: TabMirror;
  /** The size the page last measured for this tab. */
  size: TermSize | null;
}

interface PtySession {
  child: ChildProcess;
  /** The directory the shell started in. */
  cwd: string;
  /** Whether the user has sent the shell any input (typing, not terminal answers). */
  used: boolean;
  /** Holds input until the shell has drawn its first prompt. */
  gate: InputGate;
  frames: LineSplitter;
  /** The shell's exit code, from the bridge's `X` frame. */
  exitCode: number | null;
}

/** Quiet time after the shell's first output that means its prompt is drawn. */
const SHELL_QUIET_MS = 200;
/** Input is let through after this long even if the shell stays silent. */
const SHELL_READY_MAX_MS = 3000;

export interface InputGate {
  /** Write `text` now if the shell is ready, else queue it. */
  send(text: string): void;
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
export function createInputGate(
  write: (text: string) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
): InputGate {
  let ready = false;
  let quiet: unknown;
  const queued: string[] = [];
  const open = () => {
    ready = true;
    cancel(quiet);
    cancel(fallback);
    for (const text of queued.splice(0)) write(text);
  };
  // A shell that stays silent still gets its input.
  const fallback = schedule(open, SHELL_READY_MAX_MS);
  return {
    send: (text) => (ready ? write(text) : void queued.push(text)),
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

/** Lines the test channel's mirror shows (the newest). */
const MIRROR_ROWS = 14;

/** What a tab's shell needs from the pane. */
interface SessionDeps {
  sessions: Map<number, PtySession>;
  cwd: Accessor<string>;
  app: Accessor<ExternalTerminalApp | undefined>;
  /** The size a shell starts with when the page has not measured its tab yet. */
  lastSize: () => TermSize;
  /** New output for a tab, as base64 chunks. */
  output: (tab: TermTab, chunks: string[]) => void;
  /** A tab starts over: its screen, scrollback and title go. */
  reset: (tab: TermTab) => void;
}

function createMirror(lines: Signal<string[]>): TabMirror {
  return { text: createTextMirror(), utf8: createUtf8Stream(), lines };
}

function createTermTab(id: number, initialShell: ShellProfile): TermTab {
  const shell = signal<ShellProfile>(initialShell);
  const programTitle = signal("");
  return {
    id,
    shell,
    programTitle,
    title: computed(() => `${id}: ${programTitle() || shell().name}`),
    history: createOutputHistory(),
    mirror: createMirror(signal<string[]>([])),
    size: null,
  };
}

/** Write a frame to a bridge; one that already exited (EPIPE) drops it. */
function writeToChild(child: ChildProcess, frame: string): void {
  try {
    child.write(frame);
  } catch {
    // The bridge is gone; its exit line says so.
  }
}

/** The bridge's stdout: output frames go to the tab, the exit frame is kept for the exit line. */
function readBridge(tab: TermTab, session: PtySession, text: string, deps: SessionDeps): void {
  if (deps.sessions.get(tab.id) !== session) return;
  const chunks: string[] = [];
  for (const line of session.frames.push(text)) {
    const event = parseBridgeLine(line);
    if (event?.kind === "output") chunks.push(event.data);
    else if (event?.kind === "exit") session.exitCode = event.code;
  }
  if (chunks.length === 0) return;
  session.gate.output();
  deps.output(tab, chunks);
}

/**
 * A shell exited. A restarted tab (new folder or shell) already runs a new
 * session; the old shell's late exit must not end it.
 */
function endSession(tab: TermTab, session: PtySession, code: number | null | undefined, deps: SessionDeps): void {
  if (deps.sessions.get(tab.id) !== session) return;
  deps.sessions.delete(tab.id);
  const exit = session.exitCode ?? code;
  const status = exit === null || exit === undefined ? "" : ` (exit ${exit})`;
  deps.output(tab, [textChunk(`\r\n[${untracked(() => tab.title())}] session ended${status}\r\n`)]);
}

/** The bridge's arguments: the shell, TERM_PROGRAM, Ghostty's resources and the start size. */
function bridgeArgs(tab: TermTab, deps: SessionDeps): string[] {
  const app = untracked(() => deps.app());
  const size = tab.size ?? deps.lastSize();
  return [
    "-u",
    "-c",
    PTY_BRIDGE_PY,
    untracked(() => tab.shell().path),
    app?.termProgram || process.env.TERM_PROGRAM || "Aed",
    app?.resourcesDir || "",
    String(size.rows),
    String(size.cols),
  ];
}

function watchBridge(tab: TermTab, session: PtySession, deps: SessionDeps): void {
  const { child } = session;
  child.on("stdout", (text) => readBridge(tab, session, text, deps));
  child.on("stderr", (text) => {
    if (deps.sessions.get(tab.id) === session) deps.output(tab, [textChunk(text.replace(/\r?\n/g, "\r\n"))]);
  });
  child.on("exit", (result) => endSession(tab, session, result.code, deps));
}

/** Start the PTY for a tab once; a failure shows in the terminal, not as a crash. */
function startSession(tab: TermTab, deps: SessionDeps): void {
  if (deps.sessions.has(tab.id)) return;
  const cwd = untracked(() => deps.cwd()) || os.homedir();
  try {
    const child = process.spawn("python3", bridgeArgs(tab, deps), { cwd, stdin: "pipe" });
    const session: PtySession = {
      child,
      cwd,
      used: false,
      gate: createInputGate((frame) => writeToChild(child, frame)),
      frames: createLineSplitter(),
      exitCode: null,
    };
    deps.sessions.set(tab.id, session);
    watchBridge(tab, session, deps);
  } catch (error) {
    deps.output(tab, [textChunk(`[error] ${String(error)}\r\n`)]);
  }
}

function disposeSession(id: number, sessions: Map<number, PtySession>): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.child.kill();
  } catch {
    // The bridge already exited.
  }
  session.child.dispose();
}

function disposeAllSessions(sessions: Map<number, PtySession>): void {
  for (const id of [...sessions.keys()]) disposeSession(id, sessions);
}

/** Replace a tab's shell with a fresh one, on a clean screen. */
function restartSession(tab: TermTab, deps: SessionDeps): void {
  disposeSession(tab.id, deps.sessions);
  deps.reset(tab);
  startSession(tab, deps);
}

/**
 * Keys from the page for a tab's shell. A key in a tab whose shell ended
 * starts a new one. Terminal answers (`isTerminalReport`) go straight to the
 * shell that asked, past the start-up gate, and do not make it "used".
 */
function sendInput(tab: TermTab, msg: { data: string; binary: boolean }, deps: SessionDeps): void {
  const report = isTerminalReport(msg.data);
  if (!report) startSession(tab, deps);
  const session = deps.sessions.get(tab.id);
  if (!session) return;
  const frame = encodeInputFrame(msg.binary ? binaryStringBytes(msg.data) : msg.data);
  if (report) {
    writeToChild(session.child, frame);
    return;
  }
  session.used = true;
  session.gate.send(frame);
}

/** The page measured a tab: its shell gets the size (TIOCSWINSZ, then SIGWINCH). */
function resizeSession(tab: TermTab, size: TermSize, deps: SessionDeps): void {
  tab.size = size;
  const frame = encodeResizeFrame(size.rows, size.cols);
  const session = deps.sessions.get(tab.id);
  if (frame && session) writeToChild(session.child, frame);
}

/**
 * A new default shell (Preferences): tabs nobody has typed into take it,
 * restarting if their old shell runs; used tabs keep theirs.
 */
function adoptShell(tabs: TermTab[], shell: ShellProfile, deps: SessionDeps): void {
  for (const tab of tabs) {
    const session = deps.sessions.get(tab.id);
    if (session?.used || untracked(() => tab.shell().path) === shell.path) continue;
    tab.shell.set(shell);
    if (session) restartSession(tab, deps);
  }
}

/** Restart every tab whose shell should follow the open folder (see `shouldFollowCwd`). */
function followFolder(tabs: TermTab[], deps: SessionDeps): void {
  const dir = untracked(() => deps.cwd()) || os.homedir();
  for (const tab of tabs) {
    if (shouldFollowCwd(deps.sessions.get(tab.id), dir)) restartSession(tab, deps);
  }
}

type PageHandlers = {
  [K in TerminalPageMessage["type"]]: (msg: Extract<TerminalPageMessage, { type: K }>) => void;
};

function routePageMessage(msg: TerminalPageMessage, handlers: PageHandlers): void {
  (handlers[msg.type] as (m: TerminalPageMessage) => void)(msg);
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

/** The terminal WebView: its ref, and whether the injected runtime said `ready`. */
interface TerminalPage {
  view: WebViewRef | null;
  ready: boolean;
}

/** A pane's state, shared by the functions below and its component. */
interface TerminalModel {
  sessions: Map<number, PtySession>;
  tabs: Signal<TermTab[]>;
  activeId: Signal<number>;
  selectedShell: Signal<ShellProfile>;
  page: TerminalPage;
  /** Whether the terminal has the keyboard (the page says so). */
  focused: Signal<boolean>;
  /** The test channel is in use: the plain-text mirror is fed and shown. */
  mirrorOn: Signal<boolean>;
  /** The size the page last measured; new shells start with it. */
  lastSize: TermSize;
  nextId: () => number;
  deps: SessionDeps;
}

/** JS for the page, dropped while it is not ready (its `ready` replays everything). */
function inject(page: TerminalPage, js: string): void {
  if (page.ready) page.view?.injectJavaScript(js);
}

function activeTabOf(model: TerminalModel): TermTab {
  const list = untracked(() => model.tabs());
  const id = untracked(() => model.activeId());
  return list.find((tab) => tab.id === id) ?? list[0];
}

function tabOf(model: TerminalModel, id: number): TermTab | undefined {
  return untracked(() => model.tabs()).find((tab) => tab.id === id);
}

function feedMirror(tab: TermTab, chunks: string[]): void {
  const { text, utf8, lines } = tab.mirror;
  for (const chunk of chunks) text.push(utf8.push(decodeBase64(chunk)));
  lines.set([...text.lines(), text.current()]);
}

function clearMirror(tab: TermTab): void {
  tab.mirror = createMirror(tab.mirror.lines);
  tab.mirror.lines.set([]);
}

/** Output for a tab: kept for replay, mirrored for tests, and written to the page. */
function showOutput(model: TerminalModel, tab: TermTab, chunks: string[]): void {
  for (const chunk of chunks) tab.history.push(chunk);
  if (untracked(() => model.mirrorOn())) feedMirror(tab, chunks);
  inject(model.page, pageCall("write", tab.id, chunks));
}

function resetTab(model: TerminalModel, tab: TermTab): void {
  tab.history.clear();
  clearMirror(tab);
  tab.programTitle.set("");
  inject(model.page, pageCall("reset", tab.id));
}

function createTerminalModel(
  firstShell: ShellProfile,
  selectedShell: Signal<ShellProfile>,
  cwd: Accessor<string>,
  app: Accessor<ExternalTerminalApp | undefined>
): TerminalModel {
  let counter = 1;
  const firstTab = createTermTab(counter, firstShell);
  const model: TerminalModel = {
    sessions: new Map(),
    tabs: signal<TermTab[]>([firstTab]),
    activeId: signal(firstTab.id),
    selectedShell,
    page: { view: null, ready: false },
    focused: signal(false),
    mirrorOn: signal(false),
    lastSize: { rows: DEFAULT_ROWS, cols: DEFAULT_COLS },
    nextId: () => ++counter,
    deps: undefined as unknown as SessionDeps,
  };
  model.deps = {
    sessions: model.sessions,
    cwd,
    app,
    lastSize: () => model.lastSize,
    output: (tab, chunks) => showOutput(model, tab, chunks),
    reset: (tab) => resetTab(model, tab),
  };
  return model;
}

function focusTerminal(model: TerminalModel): void {
  model.page.view?.focus();
  inject(model.page, pageCall("focus"));
}

/** ⌘K while the terminal has the keyboard. */
function clearActive(model: TerminalModel): void {
  const tab = activeTabOf(model);
  clearMirror(tab);
  inject(model.page, pageCall("clear", tab.id));
}

function addTab(model: TerminalModel, shell: ShellProfile): void {
  const tab = createTermTab(model.nextId(), shell);
  model.tabs.update((previous) => previous.concat([tab]));
  model.activeId.set(tab.id);
  startSession(tab, model.deps);
  focusTerminal(model);
}

/** Close a tab and its shell; the last tab closing opens a new one at once. */
function closeTab(model: TerminalModel, id: number): void {
  disposeSession(id, model.sessions);
  inject(model.page, pageCall("close", id));
  const remaining = untracked(() => model.tabs()).filter((tab) => tab.id !== id);
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
  if (model.sessions.get(tab.id)?.used) {
    addTab(model, shell);
    return;
  }
  tab.shell.set(shell);
  restartSession(tab, model.deps);
  focusTerminal(model);
}

/** The page became ready: options, every tab's output so far, the active tab. */
function replayToPage(model: TerminalModel, options: unknown): void {
  model.page.ready = true;
  inject(model.page, pageCall("configure", options));
  for (const tab of untracked(() => model.tabs())) inject(model.page, pageCall("write", tab.id, tab.history.chunks()));
  inject(model.page, pageCall("select", untracked(() => model.activeId())));
}

function createPageHandlers(model: TerminalModel, onReady: () => void): PageHandlers {
  return {
    ready: onReady,
    input: (msg) => {
      const tab = tabOf(model, msg.tab);
      if (tab) sendInput(tab, msg, model.deps);
    },
    resize: (msg) => {
      const tab = tabOf(model, msg.tab);
      if (!tab) return;
      model.lastSize = { rows: msg.rows, cols: msg.cols };
      resizeSession(tab, model.lastSize, model.deps);
    },
    title: (msg) => tabOf(model, msg.tab)?.programTitle.set(msg.title),
    link: (msg) => void openUrl(msg.url),
    focus: (msg) => model.focused.set(msg.focused),
  };
}

function onPageMessage(handlers: PageHandlers, raw: string): void {
  const msg = parseTerminalPageMessage(raw);
  if (msg) routePageMessage(msg, handlers);
}

/**
 * Test channel; the packaged app's host never sends it. `aed.terminal.page`
 * delivers a page message as if the page posted it (`tab` defaults to the
 * active tab; headless tests run no page JS, DESIGN.md trap #10) and turns on
 * the plain-text mirror (`id:terminal-mirror`) that tests read.
 */
function onTestMessage(model: TerminalModel, handlers: PageHandlers, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  if (!untracked(() => model.mirrorOn())) {
    model.mirrorOn.set(true);
    for (const tab of untracked(() => model.tabs())) feedMirror(tab, tab.history.chunks());
  }
  onPageMessage(handlers, JSON.stringify({ tab: untracked(() => model.activeId()), ...data }));
}

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

/**
 * A bottom-dock terminal: one xterm per tab in one WebView, each on a PTY
 * bridge process; discovers local terminal apps (Ghostty, iTerm2, Warp,
 * kitty, WezTerm, Alacritty, Terminal) and installed shells, and applies
 * local Ghostty font settings.
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
  /** The page is mounted the first time the panel shows, then kept. */
  const pageMounted = signal(false);

  const activeTab = computed(() => tabs().find((tab) => tab.id === activeId()) ?? tabs()[0]);
  const activeTheme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);
  const termOptions = computed(() => buildTerminalOptions(activeTheme(), terminalFont(props, ghosttyCfg())));
  /** Built once: a new `html` value would reload the page. */
  const shellHtml = buildTerminalShellHtml(untracked(() => activeTheme().ui.background));

  const handlers = createPageHandlers(model, () => {
    replayToPage(model, untracked(() => termOptions()));
    if (untracked(() => props.visible())) focusTerminal(model);
  });
  host.on("aed.terminal.page", (data) => onTestMessage(model, handlers, data));

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
    // Outside this effect's run: a shell spawned inside it ends when the effect runs again.
    setTimeout(() => adoptShell(untracked(() => tabs()), resolved, model.deps), 0);
  });

  // Shells start the first time the panel shows (no hidden login shell at
  // launch), outside the effect's run (DESIGN.md trap #8).
  effect(() => {
    if (!props.visible()) {
      focused.set(false);
      return;
    }
    pageMounted.set(true);
    setTimeout(() => startShown(model), 0);
  });
  effect(() => {
    cleanup(() => disposeAllSessions(model.sessions));
  });

  effect(() => {
    void props.cwd();
    setTimeout(() => followFolder(untracked(() => tabs()), model.deps), 0);
  });

  effect(() => {
    inject(model.page, pageCall("select", activeId()));
  });
  effect(() => {
    inject(model.page, pageCall("configure", termOptions()));
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
        <If when={pageMounted()}>
          <WebView
            ref={(r) => {
              model.page.view = r;
            }}
            testID="terminal-view"
            html={shellHtml}
            class="flex-1"
            onLoad={() => {
              // A (re)loaded page knows nothing: runtime first, then its `ready` replays the tabs.
              model.page.ready = false;
              model.page.view?.injectJavaScript(XTERM_RUNTIME_JS);
            }}
            onMessage={({ data }) => onPageMessage(handlers, data)}
            onBlur={() => focused.set(false)}
          />
        </If>
        <If when={mirrorOn()}>
          <View testID="terminal-mirror" class="absolute inset-0 flex-col overflow-hidden">
            {/* The newest lines, one row each, so all of them stay on screen for `app.texts()`. */}
            <Each of={activeTab().mirror.lines().slice(-MIRROR_ROWS)} key="index">
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
