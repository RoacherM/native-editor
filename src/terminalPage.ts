import { Buffer } from "buffer";
import type { EditorTheme } from "./themes";
import { XTERM_CSS } from "./xtermVendor.generated";

// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」documents this module's
// contract. Pure protocol for the terminal (no I/O): the python3 PTY bridge
// and its line frames, the page's messages and calls, the shell page, the
// xterm theme, and the host's replay buffer and text mirror.
// src/TerminalPane.tsx is the I/O shell around it.

/** PTY size before the page has measured itself. */
export const DEFAULT_ROWS = 32;
export const DEFAULT_COLS = 140;
const MAX_ROWS = 500;
const MAX_COLS = 1000;

/**
 * The PTY bridge, run as `python3 -u -c PTY_BRIDGE_PY shell termProgram
 * ghosttyResourcesDir rows cols`. `pty.fork()` gives the shell a real
 * terminal. Line frames both ways, so a chunk boundary never cuts a
 * character or a frame:
 * - stdin: `D<base64>` input bytes; `R<rows> <cols>` resize (TIOCSWINSZ, the
 *   kernel sends the shell SIGWINCH);
 * - stdout: `O<base64>` output bytes; `X<code>` once the shell ended
 *   (128+n for signal n), then the bridge exits.
 * Input waits in a queue and goes to the PTY only when it can take it, so a
 * shell that does not read never blocks its output. EOF on stdin hangs up
 * the shell.
 */
export const PTY_BRIDGE_PY = `
import base64, fcntl, os, pty, select, signal, struct, sys, termios

def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass

def emit(data):
    view = memoryview(data)
    while view:
        view = view[os.write(1, view):]

def exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1

def parse_size(rows, cols):
    try:
        return max(1, min(${MAX_ROWS}, int(rows))), max(1, min(${MAX_COLS}, int(cols)))
    except ValueError:
        return None

def start(argv):
    shell = argv[1] or os.environ.get("SHELL") or "/bin/sh"
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["TERM_PROGRAM"] = argv[2] or "Aed"
        os.environ["DISABLE_AUTO_TITLE"] = "true"
        os.environ["PROMPT_EOL_MARK"] = ""
        if argv[3]:
            os.environ["GHOSTTY_RESOURCES_DIR"] = argv[3]
        os.execvp(shell, [shell, "-l"])
    set_size(master, *(parse_size(argv[4], argv[5]) or (${DEFAULT_ROWS}, ${DEFAULT_COLS})))
    fcntl.fcntl(master, fcntl.F_SETFL, fcntl.fcntl(master, fcntl.F_GETFL) | os.O_NONBLOCK)
    return pid, master

def handle_frame(line, master, outbox):
    if line[:1] == b"D":
        try:
            outbox += base64.b64decode(line[1:], validate=True)
        except ValueError:
            pass
    elif line[:1] == b"R":
        parts = line[1:].split()
        size = parse_size(*parts) if len(parts) == 2 else None
        if size:
            set_size(master, *size)

def pump(pid, master):
    pending, outbox, stdin_open = b"", bytearray(), True
    while True:
        try:
            r, w, _ = select.select([master] + ([0] if stdin_open else []), [master] if outbox else [], [])
        except (OSError, ValueError):
            return
        if master in r:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError:
                return
            if data == b"":
                return
            if data:
                emit(b"O" + base64.b64encode(data) + b"\\n")
        if master in w:
            try:
                del outbox[:os.write(master, bytes(outbox[:65536]))]
            except BlockingIOError:
                pass
            except OSError:
                return
        if 0 in r:
            chunk = os.read(0, 65536)
            if not chunk:
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
                continue
            *lines, pending = (pending + chunk).split(b"\\n")
            for line in lines:
                handle_frame(line, master, outbox)

def main():
    argv = sys.argv + [""] * 6
    pid, master = start(argv)
    pump(pid, master)
    try:
        code = exit_code(os.waitpid(pid, 0)[1])
    except ChildProcessError:
        code = 1
    emit(b"X%d\\n" % code)

main()
`;

/** Bytes as base64. */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Base64 as bytes. */
export function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** A binary string (one char per byte, as xterm's `onBinary` gives) as bytes. */
export function binaryStringBytes(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data.charCodeAt(i) & 0xff;
  return out;
}

/** An input frame for the shell: text (sent as UTF-8) or bytes. */
export function encodeInputFrame(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return `D${encodeBase64(bytes)}\n`;
}

/** Text (sent as UTF-8) as one base64 output chunk, for lines the host itself shows. */
export function textChunk(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}

const isSize = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;

/** A resize frame, or null for a size no terminal has. */
export function encodeResizeFrame(rows: number, cols: number): string | null {
  return isSize(rows, MAX_ROWS) && isSize(cols, MAX_COLS) ? `R${rows} ${cols}\n` : null;
}

export interface LineSplitter {
  /** The lines `chunk` completes (without `\n`); the unfinished rest waits. */
  push(chunk: string): string[];
}

/** Splits the bridge's stdout, which arrives in chunks of any size, into its line frames. */
export function createLineSplitter(): LineSplitter {
  let rest = "";
  return {
    push(chunk) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      return lines;
    },
  };
}

export type BridgeEvent =
  | { kind: "output"; data: string }
  | { kind: "exit"; code: number };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** One stdout line of the bridge, or null for anything else. */
export function parseBridgeLine(line: string): BridgeEvent | null {
  const body = line.slice(1);
  if (line[0] === "O" && body.length % 4 === 0 && BASE64.test(body)) {
    return { kind: "output", data: body };
  }
  if (line[0] === "X" && /^-?\d+$/.test(body)) {
    return { kind: "exit", code: Number(body) };
  }
  return null;
}

export interface Utf8Stream {
  /** The text of `bytes`; an unfinished character waits for the next push. */
  push(bytes: Uint8Array): string;
}

/** How many bytes the UTF-8 sequence led by `lead` has (1 for a stray byte). */
function utf8Length(lead: number): number {
  if (lead >= 0xf0 && lead <= 0xf7) return 4;
  if (lead >= 0xe0) return lead <= 0xef ? 3 : 1;
  return lead >= 0xc0 ? 2 : 1;
}

/** Where an unfinished trailing sequence starts (`bytes.length` if none). */
function unfinishedTail(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 3); i -= 1) {
    if ((bytes[i] & 0xc0) !== 0x80) {
      return i + utf8Length(bytes[i]) > bytes.length ? i : bytes.length;
    }
  }
  return bytes.length;
}

/** Decodes a byte stream whose chunks may split characters. */
export function createUtf8Stream(): Utf8Stream {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = new Uint8Array(0);
  return {
    push(bytes) {
      const all = new Uint8Array(carry.length + bytes.length);
      all.set(carry);
      all.set(bytes, carry.length);
      const cut = unfinishedTail(all);
      carry = all.slice(cut);
      return decoder.decode(all.subarray(0, cut));
    },
  };
}

/**
 * Whether `data` is only xterm answering the program (device attributes,
 * cursor position, status, focus, colour queries), not the user typing.
 * Such answers do not make a shell "used".
 */
const TERMINAL_REPORT =
  /^(?:\u001b\[[?>]?[\d;]*c|\u001b\[\d+;\d+R|\u001b\[\d*n|\u001b\[[IO]|\u001b\[\?[\d;]*\$y|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bP[^\u001b]*\u001b\\)+$/;

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data);
}

/** Output kept per tab for the page to replay (~1 MB of bytes as base64). */
export const HISTORY_CAP_CHARS = 1_400_000;

export interface OutputHistory {
  push(chunk: string): void;
  chunks(): string[];
  clear(): void;
}

/**
 * The output the page has to show, as base64 chunks: replayed when the page
 * becomes ready (also after a reload). The oldest chunks go past `cap`
 * characters; the newest chunk always stays.
 */
export function createOutputHistory(cap = HISTORY_CAP_CHARS): OutputHistory {
  let list: string[] = [];
  let size = 0;
  return {
    push(chunk) {
      list.push(chunk);
      size += chunk.length;
      while (size > cap && list.length > 1) size -= list.shift()!.length;
    },
    chunks: () => list.slice(),
    clear() {
      list = [];
      size = 0;
    },
  };
}

export interface TextMirror {
  push(text: string): void;
  lines(): string[];
  /** The line being written (no line break yet). */
  current(): string;
  clear(): void;
}

/** Non-CSI escapes: OSC, DCS, APC, charset designations, and 2-byte ESC sequences. */
const NON_CSI_ESCAPES =
  /\u001b[\]P^_k][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#%][0-9A-Za-z]|\u001b[^[\]P^_k()#%]/g;
/** A CSI sequence `\x1b[...X` or one non-ESC character. */
const TERM_TOKEN = /\u001b\[([0-9:;<=>?]*)([ -/]*[@-~])|([^\u001b])/g;
/** An unfinished escape sequence at the end of a chunk. */
const UNFINISHED_ESCAPE =
  /\u001b(?:\][^\u0007\u001b]*|[P^_k][^\u0007\u001b]*|\[[0-9:;<=>?]*[ -/]*|[()#%]?)$/;

interface MirrorLine {
  buffer: string;
  col: number;
}

function putChar(line: MirrorLine, ch: string): void {
  const { buffer, col } = line;
  line.buffer =
    col >= buffer.length
      ? buffer + " ".repeat(col - buffer.length) + ch
      : buffer.slice(0, col) + ch + buffer.slice(col + 1);
  line.col += 1;
}

const CURSOR_MOVES: Readonly<Record<string, (line: MirrorLine, n: number) => void>> = {
  D: (line, n) => (line.col = Math.max(0, line.col - n)),
  C: (line, n) => (line.col = Math.min(line.buffer.length, line.col + n)),
  G: (line, n) => (line.col = Math.max(0, n - 1)),
};

/** `CSI K`: 2 erases the line, none or 0 from the cursor to its end. */
function eraseInLine(line: MirrorLine, params: string): void {
  if (params === "2") Object.assign(line, { buffer: "", col: 0 });
  else if (params === "" || params === "0") line.buffer = line.buffer.slice(0, line.col);
}

/** Cursor moves and erases on the current line; `true` for a full-screen clear. */
function applyCsi(line: MirrorLine, params: string, cmd: string): boolean {
  const move = Object.hasOwn(CURSOR_MOVES, cmd) ? CURSOR_MOVES[cmd] : undefined;
  if (move) move(line, Number.parseInt(params, 10) || 1);
  else if (cmd === "K") eraseInLine(line, params);
  return cmd === "J" && (params === "2" || params === "3");
}

/** Text without an escape sequence cut off at its end, and that tail (held for the next chunk). */
function splitUnfinishedEscape(text: string): { text: string; tail: string } {
  const tail = UNFINISHED_ESCAPE.exec(text);
  return tail && text.length - tail.index < 512
    ? { text: text.slice(0, tail.index), tail: tail[0] }
    : { text, tail: "" };
}

/** One character: CR, LF (ends the line into `done`), backspace, or a printable one. */
function applyChar(line: MirrorLine, ch: string, done: string[]): void {
  if (ch === "\r") line.col = 0;
  else if (ch === "\n") {
    done.push(line.buffer);
    Object.assign(line, { buffer: "", col: 0 });
  } else if (ch === "\b") line.col = Math.max(0, line.col - 1);
  else if (ch === "\t" || ch >= " ") putChar(line, ch);
}

/**
 * The terminal's output as plain lines, ANSI removed: CR, LF, backspace and
 * the cursor/erase sequences shells use on one line (`D`, `C`, `G`, `K`;
 * `J` 2/3 clears). Only the test channel reads it (`aed.terminal.*`).
 */
export function createTextMirror(maxLines = 1000): TextMirror {
  let done: string[] = [];
  const line: MirrorLine = { buffer: "", col: 0 };
  let escape = "";
  const keep = (lines: string[]) => (lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines);
  return {
    push(text) {
      const split = splitUnfinishedEscape(escape + text);
      escape = split.tail;
      for (const m of split.text.replace(NON_CSI_ESCAPES, "").matchAll(TERM_TOKEN)) {
        if (m[2] !== undefined && applyCsi(line, m[1] ?? "", m[2])) done = [];
        else if (m[3] !== undefined) applyChar(line, m[3], done);
      }
      done = keep(done);
    },
    lines: () => done.slice(),
    current: () => line.buffer,
    clear() {
      done = [];
      Object.assign(line, { buffer: "", col: 0 });
    },
  };
}

export type TerminalPageMessage =
  | { type: "ready" }
  | { type: "input"; tab: number; data: string; binary: boolean }
  | { type: "resize"; tab: number; rows: number; cols: number }
  | { type: "title"; tab: number; title: string }
  | { type: "link"; url: string }
  | { type: "focus"; focused: boolean };

/** Input one message may carry (a large paste); its frame stays under the 1 MiB stdin queue. */
const MAX_INPUT_CHARS = 192 * 1024;
const MAX_TITLE_CHARS = 200;

const isTabId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function parseInput(m: Record<string, unknown>): TerminalPageMessage | null {
  if (!isTabId(m.tab) || typeof m.data !== "string" || m.data.length > MAX_INPUT_CHARS) return null;
  return { type: "input", tab: m.tab, data: m.data, binary: m.binary === true };
}

function parseResize(m: Record<string, unknown>): TerminalPageMessage | null {
  const { tab, rows, cols } = m;
  if (!isTabId(tab) || typeof rows !== "number" || typeof cols !== "number") return null;
  return encodeResizeFrame(rows, cols) ? { type: "resize", tab, rows, cols } : null;
}

function parseTitle(m: Record<string, unknown>): TerminalPageMessage | null {
  if (!isTabId(m.tab) || typeof m.title !== "string") return null;
  const title = m.title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_TITLE_CHARS);
  return { type: "title", tab: m.tab, title };
}

function parseLink(m: Record<string, unknown>): TerminalPageMessage | null {
  return typeof m.url === "string" && /^https?:\/\/\S+$/i.test(m.url) ? { type: "link", url: m.url } : null;
}

const PAGE_MESSAGE_PARSERS: Record<string, (m: Record<string, unknown>) => TerminalPageMessage | null> = {
  ready: () => ({ type: "ready" }),
  input: parseInput,
  resize: parseResize,
  title: parseTitle,
  link: parseLink,
  focus: (m) => (typeof m.focused === "boolean" ? { type: "focus", focused: m.focused } : null),
};

/** A page message (`window.nsh.postMessage` JSON), validated; null if malformed. */
export function parseTerminalPageMessage(raw: string): TerminalPageMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const parse = typeof m.type === "string" ? PAGE_MESSAGE_PARSERS[m.type] : undefined;
  return parse && Object.hasOwn(PAGE_MESSAGE_PARSERS, m.type as string) ? parse(m) : null;
}

/** The Content-Security-Policy the terminal page runs under: no scripts of its own. */
export const TERMINAL_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'";

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * The static page for `WebView.html`: CSP, xterm's CSS, one root. No
 * `<script>`; the runtime is injected on load (DESIGN.md trap #10).
 * `background` (the theme's at mount) avoids a white flash before it runs.
 */
export function buildTerminalShellHtml(background: string): string {
  const bg = HEX_COLOR.test(background) ? background : "#000000";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${TERMINAL_CSP}">
<style>${XTERM_CSS}</style>
<style>html,body{margin:0;height:100%;overflow:hidden;background:${bg}}#aed-term-root{position:absolute;inset:0}.aed-term{position:absolute;inset:0}.aed-term .xterm{height:100%;padding:6px 0 0 12px;box-sizing:border-box}</style>
</head>
<body>
<div id="aed-term-root"></div>
</body>
</html>`;
}

export type PageMethod = "configure" | "select" | "write" | "clear" | "reset" | "close" | "focus";

/** A call of the page runtime (`window.__aedTerm`), as JS to inject. */
export function pageCall(method: PageMethod, ...args: unknown[]): string {
  const list = args.map((a) => JSON.stringify(a)).join(",");
  return `window.__aedTerm&&window.__aedTerm.${method}(${list});`;
}

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const ANSI_NAMES: readonly (keyof AnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function palette(colors: string): AnsiPalette {
  const list = colors.trim().split(/\s+/);
  return Object.fromEntries(ANSI_NAMES.map((name, i) => [name, list[i]])) as unknown as AnsiPalette;
}

/**
 * The 16 ANSI colours per theme, in ANSI order. The upstream palettes of
 * each theme, except where a colour is too faint on the theme's background
 * (bright black is zsh's autosuggestion colour; light themes keep `white`
 * readable as text).
 */
export const ANSI_PALETTES: Readonly<Record<string, AnsiPalette>> = {
  "industrial-paper": palette(`
    #141414 #c62d14 #4d6b1f #8a5a00 #2f4b63 #8e3b6b #2b6b6b #6d685f
    #57534b #b0260f #5e7d2a #9c4a07 #3d6a8f #a8467f #357f7f #7a7468`),
  "industrial-carbon": palette(`
    #2a2826 #f06a4f #b5c28f #e0a96d #9fb4c7 #d199b5 #8fc1b5 #d9d3c7
    #8f897e #ff8466 #cbd8a3 #f0c08a #b9cde0 #e3b3cb #a9d6cb #f7f4ee`),
  "kanagawa-dragon": palette(`
    #0d0c0c #c4746e #8a9a7b #c4b28a #8ba4b0 #a292a3 #8ea4a2 #c8c093
    #a6a69c #e46876 #87a987 #e6c384 #7fb4ca #938aa9 #7aa89f #c5c9c5`),
  "tokyo-night": palette(`
    #15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6
    #737aa2 #ff899d #9fe044 #faba4a #8db0ff #c7a9ff #a4daff #c0caf5`),
  "catppuccin-mocha": palette(`
    #45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de
    #7f849c #f37799 #89d88b #ebd391 #74a8fc #f2aede #6bd7ca #a6adc8`),
  "one-dark": palette(`
    #282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf
    #7f848e #e88389 #a9d18b #f0cf8f #7cbdf5 #d48fe8 #6fc7d2 #ffffff`),
  "rose-pine": palette(`
    #26233a #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4
    #6e6a86 #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4`),
  "github-light": palette(`
    #24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781
    #57606a #a40e26 #1a7f37 #633c01 #0550ae #6639ba #136061 #57606a`),
};

/** A theme without its own palette: ANSI colours from its syntax colours. */
function derivedPalette(theme: EditorTheme): AnsiPalette {
  const { ui, syntax } = theme;
  const dark = theme.appearance === "dark";
  const base = [
    dark ? ui.card : ui.foreground, syntax.keyword, syntax.string, syntax.number,
    syntax.property, syntax.constant, syntax.operator, dark ? ui.foreground : ui.mutedForeground,
  ];
  return palette([...base, ui.mutedForeground, ...base.slice(1, 7), dark ? ui.foreground : ui.mutedForeground].join(" "));
}

export interface XtermTheme extends AnsiPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
}

/** An app theme as an xterm ITheme: `theme.ui` planes plus the 16 ANSI colours. */
export function buildXtermTheme(theme: EditorTheme): XtermTheme {
  const { ui } = theme;
  return {
    background: ui.background,
    foreground: ui.foreground,
    cursor: ui.accent,
    cursorAccent: ui.background,
    selectionBackground: ui.selection,
    scrollbarSliderBackground: `${ui.mutedForeground.slice(0, 7)}40`,
    scrollbarSliderHoverBackground: `${ui.mutedForeground.slice(0, 7)}70`,
    scrollbarSliderActiveBackground: `${ui.mutedForeground.slice(0, 7)}90`,
    ...(ANSI_PALETTES[theme.id] ?? derivedPalette(theme)),
  };
}

/** A CSS font stack with the user's family first. */
export function cssFontStack(family: string | undefined): string {
  const clean = (family ?? "").replace(/["'\\;{}]/g, "").trim();
  const fallback = "ui-monospace, Menlo, monospace";
  return clean ? `'${clean}', ${fallback}` : fallback;
}

/** The page's `configure` payload. */
export function buildTerminalOptions(
  theme: EditorTheme,
  font: { fontFamily?: string; fontSize: number }
): { theme: XtermTheme; fontFamily: string; fontSize: number } {
  return { theme: buildXtermTheme(theme), fontFamily: cssFontStack(font.fontFamily), fontSize: font.fontSize };
}
