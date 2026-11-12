// Page runtime for Aed's terminal. Injected once into the terminal WebView
// (src/TerminalPane.tsx) through ref.injectJavaScript; the host drives it via
// window.__aedTerm.* calls and reads page messages through
// window.nsh.postMessage. One xterm instance per terminal tab, all in this
// page; only the active one is shown.
//
// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」documents this protocol;
// src/terminalPage.ts validates the messages this file posts.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";

// Install guard: a duplicate inject must not attach listeners again.
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  !window.__aedTerm
) {
  const tabs = new Map();
  let activeId = 0;
  let options = { theme: {}, fontFamily: "monospace", fontSize: 13 };

  function post(obj) {
    try {
      window.nsh.postMessage(JSON.stringify(obj));
    } catch {
      // Host gone or bridge unavailable; drop the message.
    }
  }

  function decodeBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function root() {
    return document.getElementById("aed-term-root");
  }

  // ⌘ keys belong to the app (its shortcuts and menu): xterm must not turn
  // them into input. ⌘A selects the terminal's text; ⌘C / ⌘V reach the
  // browser's copy / paste events, which xterm handles.
  function keyHandler(term) {
    return (ev) => {
      if (!ev.metaKey) return true;
      if (ev.type === "keydown" && ev.key === "a") {
        term.selectAll();
        ev.preventDefault();
      } else if (ev.type === "keydown" && ev.key === "k") {
        term.clear();
      }
      return false;
    };
  }

  // The host gives ⌘K / ⌘F to the terminal only while it has the keyboard:
  // the page's own focus counts only while the web view itself has it
  // (document.hasFocus()), not a textarea focused in a background view.
  function watchFocus(term) {
    const ta = term.textarea;
    if (!ta) return;
    ta.addEventListener("focus", () => post({ type: "focus", focused: document.hasFocus() }));
    ta.addEventListener("blur", () => post({ type: "focus", focused: false }));
  }

  function isTerminalTextarea(el) {
    for (const tab of tabs.values()) if (tab.term.textarea === el) return true;
    return false;
  }

  // A paste arrives as one onData string: post it in pieces the host's
  // message limit takes, never between the halves of a surrogate pair.
  const INPUT_PIECE = 32768;
  function postInput(id, data, binary) {
    for (let i = 0; i < data.length; ) {
      let end = Math.min(data.length, i + INPUT_PIECE);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      post(binary ? { type: "input", tab: id, data: data.slice(i, end), binary: true } : { type: "input", tab: id, data: data.slice(i, end) });
      i = end;
    }
  }

  function ensure(id) {
    const existing = tabs.get(id);
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "aed-term";
    el.style.display = id === activeId ? "block" : "none";
    root().appendChild(el);
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: 1.2,
      theme: options.theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        post({ type: "link", url: uri });
      }),
    );
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.attachCustomKeyEventHandler(keyHandler(term));
    term.open(el);
    term.onData((data) => postInput(id, data, false));
    term.onBinary((data) => postInput(id, data, true));
    term.onTitleChange((title) => post({ type: "title", tab: id, title }));
    watchFocus(term);
    const tab = { term, fit, el, cols: 0, rows: 0 };
    tabs.set(id, tab);
    return tab;
  }

  // Fit the shown tab to the page and report a changed size (the host turns
  // it into an `R` frame: TIOCSWINSZ, then SIGWINCH for the shell).
  function fitTab(id) {
    const tab = tabs.get(id);
    if (!tab || tab.el.style.display === "none") return;
    try {
      tab.fit.fit();
    } catch {
      // Not laid out yet; the resize observer fits again.
    }
    const { cols, rows } = tab.term;
    if (cols === tab.cols && rows === tab.rows) return;
    tab.cols = cols;
    tab.rows = rows;
    post({ type: "resize", tab: id, cols, rows });
  }

  function configure(next) {
    options = { ...options, ...next };
    document.body.style.background = options.theme.background || "";
    for (const tab of tabs.values()) {
      tab.term.options.theme = options.theme;
      tab.term.options.fontFamily = options.fontFamily;
      tab.term.options.fontSize = options.fontSize;
    }
    fitTab(activeId);
  }

  function select(id) {
    activeId = id;
    ensure(id);
    for (const [tid, tab] of tabs) {
      tab.el.style.display = tid === id ? "block" : "none";
    }
    fitTab(id);
  }

  function write(id, chunks) {
    const { term } = ensure(id);
    for (const b64 of chunks) term.write(decodeBase64(b64));
  }

  function clear(id) {
    const tab = tabs.get(id);
    if (tab) tab.term.clear();
  }

  function reset(id) {
    const tab = tabs.get(id);
    if (tab) tab.term.reset();
  }

  function close(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.term.dispose();
    tab.el.remove();
    tabs.delete(id);
  }

  function focus() {
    const tab = tabs.get(activeId);
    if (tab) tab.term.focus();
  }

  new ResizeObserver(() => fitTab(activeId)).observe(root());
  window.addEventListener("blur", () => post({ type: "focus", focused: false }));
  window.addEventListener("focus", () => {
    if (isTerminalTextarea(document.activeElement)) post({ type: "focus", focused: true });
  });

  window.__aedTerm = { configure, select, write, clear, reset, close, focus };
  post({ type: "ready" });
}
