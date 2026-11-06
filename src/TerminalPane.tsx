import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import process from "process";
import type { ChildProcess } from "process";
import type { Accessor, InputRef, JSX, ScrollRef, Signal } from "nsh";
import {
  cleanup,
  computed,
  effect,
  Scroll,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import { Button, Input, Select, type SelectItem } from "nsh/base";
import { Icon } from "./icons";

export interface TerminalPaneProps {
  cwd: Accessor<string>;
  fontFamily?: Accessor<string>;
  fontSize?: Accessor<number>;
  shellPath?: Accessor<string>;
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
  title: Accessor<string>;
  lines: Signal<string[]>;
  current: Signal<string>;
  input: Signal<string>;
  running: Signal<boolean>;
}

interface PtySession {
  child: ChildProcess;
  escBuffer: string;
  pending: string;
  col: number;
}

/** How many output lines one session keeps. */
const MAX_LINES = 1000;

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

/**
 * The PTY bridge: `pty.fork()` gives the shell a real terminal, configured
 * dynamically with the selected shell binary and terminal program environment.
 */
// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」
const PY_PTY_SCRIPT = `
import fcntl, os, pty, select, struct, sys, termios

def main():
    shell = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else (os.environ.get("SHELL") or "/bin/sh")
    term_prog = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "NativeEditor"
    ghostty_res = sys.argv[3] if len(sys.argv) > 3 else ""
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["TERM_PROGRAM"] = term_prog
        os.environ["DISABLE_AUTO_TITLE"] = "true"
        os.environ["PROMPT_EOL_MARK"] = ""
        if ghostty_res:
            os.environ["GHOSTTY_RESOURCES_DIR"] = ghostty_res
        os.execvp(shell, [shell, "-l"])
        return
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 140, 0, 0))
    except OSError:
        pass
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    while True:
        try:
            ready, _, _ = select.select([stdin_fd, master], [], [])
        except (OSError, ValueError):
            break
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(stdout_fd, data)
        if stdin_fd in ready:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(master, data)

main()
`;

/** Non-CSI escapes: OSC, DCS, APC, charset designations, and 2-byte ESC sequences. */
const NON_CSI_ESCAPES =
  /\u001b[\]P^_k][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#%][0-9A-Za-z]|\u001b[^[\]P^_k()#%]/g;

/** Matches either a CSI sequence `\x1b[...X` or a single non-ESC character. */
const TERM_TOKEN_PATTERN =
  /\u001b\[([0-9:;<=>?]*)([ -/]*[@-~])|([^\u001b])/g;

/** Matches an unfinished escape sequence at the end of a PTY chunk. */
const INCOMPLETE_ANSI_TAIL =
  /\u001b(?:\][^\u0007\u001b]*|[P^_k][^\u0007\u001b]*|\[[0-9:;<=>?]*[ -/]*|[()#%]?)$/;

/** Buffer any split escape tail on `session` and strip non-CSI escapes. */
function extractProcessableChunk(session: PtySession, chunk: string): string {
  const combined = session.escBuffer + chunk;
  const tailMatch = INCOMPLETE_ANSI_TAIL.exec(combined);
  if (tailMatch && combined.length - tailMatch.index < 512) {
    session.escBuffer = tailMatch[0];
    return combined.slice(0, tailMatch.index).replace(NON_CSI_ESCAPES, "");
  }
  session.escBuffer = "";
  return combined.replace(NON_CSI_ESCAPES, "");
}

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

function createTermTab(id: number, initialShell: ShellProfile): TermTab {
  const shell = signal<ShellProfile>(initialShell);
  return {
    id,
    shell,
    title: computed(() => `${id}: ${shell().name}`),
    lines: signal<string[]>([]),
    current: signal(""),
    input: signal(""),
    running: signal(false),
  };
}

/** Append lines, keeping only the newest MAX_LINES. */
function pushLines(tab: TermTab, lines: string[]): void {
  if (lines.length === 0) return;
  tab.lines.update((previous) => {
    const next = previous.concat(lines);
    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  });
}

function putCharAt(buffer: string, col: number, ch: string): string {
  if (col >= buffer.length) {
    return buffer + " ".repeat(col - buffer.length) + ch;
  }
  return buffer.slice(0, col) + ch + buffer.slice(col + 1);
}

function applyCsiErase(
  tab: TermTab,
  state: { buffer: string; col: number },
  params: string,
  cmd: string
): void {
  if (cmd === "K" && (!params || params === "0")) {
    state.buffer = state.buffer.slice(0, state.col);
  } else if (cmd === "K" && params === "2") {
    state.buffer = "";
    state.col = 0;
  } else if (cmd === "J" && (params === "2" || params === "3")) {
    tab.lines.set([]);
  }
}

function applyCsiCommand(
  tab: TermTab,
  state: { buffer: string; col: number },
  params: string,
  cmd: string
): void {
  const n = Number.parseInt(params, 10) || 1;
  if (cmd === "D") state.col = Math.max(0, state.col - n);
  else if (cmd === "C") state.col = Math.min(state.buffer.length, state.col + n);
  else if (cmd === "G") state.col = Math.max(0, n - 1);
  else applyCsiErase(tab, state, params, cmd);
}

function applyTerminalChar(
  state: { buffer: string; col: number },
  ch: string,
  complete: string[]
): void {
  if (ch === "\r") state.col = 0;
  else if (ch === "\n") {
    complete.push(state.buffer);
    state.buffer = "";
    state.col = 0;
  } else if (ch === "\b") {
    state.col = Math.max(0, state.col - 1);
  } else if (ch === "\t" || ch >= " ") {
    state.buffer = putCharAt(state.buffer, state.col, ch);
    state.col += 1;
  }
}

/**
 * Turn a raw PTY chunk into lines, honouring CR, LF, backspace, and CSI
 * cursor/erase commands (`D`, `C`, `G`, `K`, `J`) used by zsh-syntax-highlighting.
 */
function appendChunk(tab: TermTab, session: PtySession, text: string): void {
  const state = { buffer: session.pending, col: session.col };
  const complete: string[] = [];
  const cleaned = extractProcessableChunk(session, text);
  for (const match of cleaned.matchAll(TERM_TOKEN_PATTERN)) {
    if (match[2] !== undefined) {
      applyCsiCommand(tab, state, match[1] ?? "", match[2]);
    } else if (match[3] !== undefined) {
      applyTerminalChar(state, match[3], complete);
    }
  }
  session.pending = state.buffer;
  session.col = state.col;
  tab.current.set(state.buffer);
  pushLines(tab, complete);
}

/** Start the PTY for a tab once; a failure shows as a line, not a crash. */
function startPtySession(
  tab: TermTab,
  sessions: Map<number, PtySession>,
  cwdAccessor: Accessor<string>,
  primaryApp: Accessor<ExternalTerminalApp | undefined>
): void {
  if (sessions.has(tab.id)) return;
  try {
    const cwd = untracked(() => cwdAccessor()) || os.homedir();
    const app = untracked(() => primaryApp());
    const termProgram = app?.termProgram || process.env.TERM_PROGRAM || "NativeEditor";
    const resourcesDir = app?.resourcesDir || "";
    const shellPath = untracked(() => tab.shell().path);
    const child = process.spawn(
      "python3",
      ["-u", "-c", PY_PTY_SCRIPT, shellPath, termProgram, resourcesDir],
      {
        cwd,
        stdin: "pipe",
      }
    );
    const session: PtySession = {
      child,
      escBuffer: "",
      pending: "",
      col: 0,
    };
    sessions.set(tab.id, session);
    tab.running.set(true);
    child.on("stdout", (text) => appendChunk(tab, session, text));
    child.on("stderr", (text) => appendChunk(tab, session, text));
    child.on("exit", () => {
      tab.running.set(false);
      sessions.delete(tab.id);
      pushLines(tab, [`[${untracked(() => tab.title())}] session ended`]);
    });
  } catch (error) {
    pushLines(tab, [`[error] ${String(error)}`]);
  }
}

function disposeSession(
  id: number,
  sessions: Map<number, PtySession>
): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.child.kill();
  } catch {
    // The shell already exited.
  }
  session.child.dispose();
  sessions.delete(id);
}

function disposeAllSessions(sessions: Map<number, PtySession>): void {
  for (const session of sessions.values()) {
    try {
      session.child.kill();
    } catch {
      // The shell already exited.
    }
  }
  sessions.clear();
}

function writeCommandToSession(
  tab: TermTab | undefined,
  sessions: Map<number, PtySession>,
  text: string
): void {
  const session = tab ? sessions.get(tab.id) : undefined;
  if (!tab || !session) return;
  session.child.write(text.endsWith("\n") ? text : `${text}\n`);
  tab.input.set("");
}

function removeTabAndSelectReplacement(
  id: number,
  tabs: Signal<TermTab[]>,
  activeId: Signal<number>,
  sessions: Map<number, PtySession>,
  cwd: Accessor<string>,
  shell: Accessor<ShellProfile>,
  primaryApp: Accessor<ExternalTerminalApp | undefined>,
  nextId: () => number
): void {
  disposeSession(id, sessions);
  tabs.update((previous) => previous.filter((tab) => tab.id !== id));
  if (activeId() !== id) return;
  const remaining = tabs();
  if (remaining.length > 0) {
    activeId.set(remaining[remaining.length - 1].id);
    return;
  }
  const replacement = createTermTab(nextId(), shell());
  tabs.set([replacement]);
  activeId.set(replacement.id);
  startPtySession(replacement, sessions, cwd, primaryApp);
}

function TermTabChip(props: {
  tab: Accessor<TermTab>;
  activeId: Accessor<number>;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
}): JSX.Element {
  const isActive = computed(() => props.tab().id === props.activeId());
  return (
    <View
      class={`flex-row items-center rounded px-1.5 py-0.5 gap-1 ${
        isActive()
          ? "bg-card text-foreground border border-border"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      <View onPress={() => props.onSelect(props.tab().id)} role="button">
        <Text
          class={`text-[11px] font-mono ${
            isActive() ? "text-foreground font-medium" : "text-muted-foreground"
          }`}
        >
          {props.tab().title()}
        </Text>
      </View>
      <View
        onPress={() => props.onClose(props.tab().id)}
        role="button"
        class="p-0.5 items-center justify-center"
      >
        <Icon name="close" size={10} tint="#7a7a7a" />
      </View>
    </View>
  );
}

function setTabInput(tab: TermTab | undefined, value: string): void {
  if (tab) tab.input.set(value);
}

function switchTabShell(
  tab: TermTab,
  nextShell: ShellProfile,
  sessions: Map<number, PtySession>,
  cwd: Accessor<string>,
  primaryApp: Accessor<ExternalTerminalApp | undefined>
): void {
  if (tab.shell().path === nextShell.path && sessions.has(tab.id)) return;
  disposeSession(tab.id, sessions);
  tab.lines.set([]);
  tab.current.set("");
  tab.input.set("");
  tab.shell.set(nextShell);
  startPtySession(tab, sessions, cwd, primaryApp);
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

/**
 * A bottom-dock terminal: dynamically discovers local terminal apps (Ghostty,
 * iTerm2, Warp, kitty, WezTerm, Alacritty, Terminal) and installed shells,
 * applies local Ghostty font/theme settings, and spawns interactive PTY tabs.
 */
function ShellSelectOptionRow(props: {
  value: string;
  title: string;
  selected: boolean;
  highlighted: boolean;
}): JSX.Element {
  const shellName = props.value.split("/").pop() || props.title;
  return (
    <View
      testID={`shell-option-${shellName}`}
      class={`h-7 px-2.5 rounded flex-row items-center justify-between gap-2 select-none ${
        props.highlighted || props.selected ? "bg-accent" : "hover:bg-muted/60"
      }`}
    >
      <View class="flex-row items-center gap-2 min-w-0 flex-1">
        <Text
          class={`text-xs font-mono text-foreground shrink-0 ${
            props.selected ? "font-semibold" : "font-normal"
          }`}
        >
          {shellName}
        </Text>
        <Text class="text-[10.5px] font-mono text-muted-foreground truncate">
          {props.value}
        </Text>
      </View>
      <View class="w-3.5 items-center justify-center shrink-0">
        <If when={props.selected}>
          <Icon name="check" size={11.5} tint="#38bdf8" />
        </If>
      </View>
    </View>
  );
}

export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  let counter = 1;
  let inputRef: InputRef | null = null;
  let scrollRef: ScrollRef | null = null;
  const sessions = new Map<number, PtySession>();
  const nextId = () => ++counter;

  const fallbackShell = defaultShellProfile();
  const shells = signal<ShellProfile[]>([fallbackShell]);
  const selectedShell = signal<ShellProfile>(
    resolveShellByPath(
      [fallbackShell],
      untracked(() => props.shellPath?.()),
      fallbackShell
    )
  );
  const externalApps = signal<ExternalTerminalApp[]>([]);
  const ghosttyCfg = signal<GhosttyConfig>({});

  const primaryExternal = computed(() => externalApps()[0]);

  const firstTab = createTermTab(
    counter,
    untracked(() => selectedShell())
  );
  const tabs = signal<TermTab[]>([firstTab]);
  const activeId = signal(firstTab.id);

  const activeTab = computed(
    () => tabs().find((tab) => tab.id === activeId()) || firstTab
  );
  const focusInput = () => inputRef?.focus();

  const applyShellSelection = (shell: ShellProfile, notifyParent: boolean) => {
    selectedShell.set(shell);
    if (notifyParent) props.onShellChange?.(shell.path);
    switchTabShell(
      untracked(() => activeTab()),
      shell,
      sessions,
      props.cwd,
      primaryExternal
    );
    focusInput();
  };

  effect(() => {
    discoverTerminalEnvironment().then((env) => {
      if (env.shells.length > 0) {
        shells.set(env.shells);
        const pref = untracked(() => props.shellPath?.());
        const resolved = resolveShellByPath(env.shells, pref, fallbackShell);
        selectedShell.set(resolved);
      }
      if (env.externalApps.length > 0) externalApps.set(env.externalApps);
      ghosttyCfg.set(env.ghostty);
    });
  });

  effect(() => {
    const extPath = props.shellPath?.();
    if (!extPath) return;
    const resolved = resolveShellByPath(
      untracked(() => shells()),
      extPath,
      fallbackShell
    );
    if (untracked(() => activeTab().shell().path) !== resolved.path) {
      applyShellSelection(resolved, false);
    }
  });

  const sendCommand = (text: string) => {
    writeCommandToSession(activeTab(), sessions, text);
    focusInput();
  };

  const addTab = () => {
    const tab = createTermTab(nextId(), selectedShell());
    tabs.update((previous) => previous.concat([tab]));
    activeId.set(tab.id);
    startPtySession(tab, sessions, props.cwd, primaryExternal);
    focusInput();
  };

  const closeTab = (id: number) => {
    removeTabAndSelectReplacement(
      id,
      tabs,
      activeId,
      sessions,
      props.cwd,
      selectedShell,
      primaryExternal,
      nextId
    );
    focusInput();
  };

  effect(() => {
    void activeId();
    focusInput();
  });

  effect(() => {
    untracked(() => {
      for (const tab of tabs()) {
        startPtySession(tab, sessions, props.cwd, primaryExternal);
      }
    });
    cleanup(() => disposeAllSessions(sessions));
  });

  effect(() => {
    void activeTab().lines();
    void activeTab().current();
    scrollRef?.scrollTo({ y: 999999, animated: false });
  });

  const shellItems = computed<SelectItem[]>(() =>
    shells().map((s) => ({
      value: s.path,
      title: s.name,
      subtitle: s.path,
    }))
  );

  const termFontStyle = computed(() => {
    const cfg = ghosttyCfg();
    const family = props.fontFamily?.() || cfg.fontFamily || undefined;
    const size =
      props.fontSize?.() ?? (cfg.fontSize ? Math.round(cfg.fontSize) : 12);
    return { fontFamily: family, fontSize: size };
  });

  return (
    <View class="flex-1 flex-col bg-sidebar" testID="terminal-pane">
      <View class="h-[28px] px-2.5 bg-sidebar border-b border-border flex-row items-center justify-between gap-2 shrink-0 select-none">
        <View class="flex-1 flex-row items-center gap-1 min-w-0 overflow-hidden">
          <Scroll horizontal class="flex-initial">
            <View class="flex-row items-center gap-1">
              <Each of={tabs()} key={(tab) => tab.id}>
                {(tab) => (
                  <TermTabChip
                    tab={tab}
                    activeId={activeId}
                    onSelect={(id) => {
                      activeId.set(id);
                      focusInput();
                    }}
                    onClose={closeTab}
                  />
                )}
              </Each>
            </View>
          </Scroll>
          <Button
            testID="terminal-add-btn"
            onPress={addTab}
            accessibilityLabel="New terminal tab"
            class="h-5 w-5 items-center justify-center rounded hover:bg-muted/50 bg-transparent border-none shadow-none p-0 shrink-0"
          >
            <Icon name="plus" size={12} tint="#8c8c8c" />
          </Button>
        </View>

        <View class="flex-row items-center pr-0.5 shrink-0">
          <Select
            testID="terminal-shell-select"
            items={shellItems()}
            value={activeTab().shell().path}
            placement="top"
            align="end"
            offset={6}
            onChange={({ value }) => {
              const next = resolveShellByPath(
                shells(),
                value ?? undefined,
                fallbackShell
              );
              applyShellSelection(next, true);
            }}
            trigger={
              <View
                testID="terminal-shell-trigger"
                class="h-5 px-2 flex-row items-center gap-1 rounded bg-card hover:bg-muted/60 border border-border"
              >
                <Text class="text-[11px] font-mono text-foreground">
                  {activeTab().shell().name}
                </Text>
                <Icon name="chevron-down" size={10} tint="#8c8c8c" />
              </View>
            }
            popupClass="w-56 rounded-lg border border-border bg-popover shadow-2xl p-1"
            itemClass="rounded cursor-pointer"
            renderItem={(item) => (
              <ShellSelectOptionRow
                value={item.value}
                title={item.title}
                selected={item.selected}
                highlighted={item.highlighted}
              />
            )}
          />
        </View>
      </View>

      <View class="flex-1 bg-background" onPress={focusInput}>
        <Scroll
          ref={(r) => {
            scrollRef = r;
          }}
          keyboardShouldPersistTaps="always"
          class="flex-1 bg-background"
          contentClass="p-2.5"
        >
          <View class="flex-col" onPress={focusInput}>
            <Each of={activeTab().lines()} key="index">
              {(line) => (
                <Text
                  class="select-text font-mono text-xs text-foreground leading-relaxed"
                  style={termFontStyle()}
                >
                  {line()}
                </Text>
              )}
            </Each>
            <View
              class="flex-row items-center min-h-[20px] gap-1.5"
              onPress={focusInput}
            >
              <Text
                class="font-mono text-xs text-foreground leading-relaxed shrink-0"
                style={termFontStyle()}
              >
                {activeTab().current().trimEnd()}
              </Text>
              <Input
                testID="terminal-input"
                ref={(r) => {
                  inputRef = r;
                  r?.focus();
                }}
                autoFocus
                caret
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  height: 20,
                  paddingHorizontal: 0,
                  paddingVertical: 0,
                  ...termFontStyle(),
                }}
                class="flex-1 h-5 font-mono text-xs text-foreground bg-transparent border-none outline-none p-0 m-0"
                value={activeTab().input()}
                onChange={({ value }) => setTabInput(activeTab(), value)}
                onSubmit={({ text }) => sendCommand(text)}
                submitBehavior="submit"
              />
            </View>
          </View>
        </Scroll>
      </View>
    </View>
  );
}
