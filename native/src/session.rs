//! A terminal tab: the libghostty-vt terminal and the shell running in it.
//! TSX holds it as the `TerminalSession` class (engine thread); the PTY
//! threads feed it and the `aed.terminal` view (main thread) draws it, all
//! through one `Arc<Shared>`. DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」.

use std::{
    collections::HashMap,
    ptr,
    sync::{
        Arc, Condvar, LazyLock, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
};

use nsh_core::prelude::*;

use crate::{ffi as g, log, pty};

/// The terminal's text before a view has measured it, in pixels per cell.
const CELL_W: u32 = 8;
const CELL_H: u32 = 16;
static SCROLLBACK_LINES: usize = 10_000;
const MAX_ROWS: u32 = 500;
const MAX_COLS: u32 = 1000;

/// What TSX hears from a session (`nextEvent`), coalesced.
#[derive(Default)]
struct Events {
    output: bool,
    title: Option<String>,
    exit: Option<i32>,
    /// Keys arrived while no shell ran.
    input: bool,
    closed: bool,
}

/// The running shell.
struct Run {
    child: pty::Child,
}

/// The terminal and its size; locked by whoever reads or changes it.
pub struct Core {
    pub term: g::GhosttyTerminal,
    pub rows: u16,
    pub cols: u16,
    cell_w: u32,
    cell_h: u32,
    run: Option<Run>,
    colors: Option<Colors>,
    /// Bumped by each start and stop: a reader of an older shell ends quietly.
    generation: u64,
}

// SAFETY: the terminal is only used under the `Mutex<Core>`.
unsafe impl Send for Core {}

/// The theme's colours for a terminal (`None`: libghostty's default).
#[derive(Clone, Default, PartialEq)]
pub struct Colors {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
    pub cursor: Option<[u8; 3]>,
    /// ANSI 0–15; 16–255 stay libghostty's.
    pub palette: [Option<[u8; 3]>; 16],
}

fn rgb(c: [u8; 3]) -> g::GhosttyColorRgb {
    g::GhosttyColorRgb { r: c[0], g: c[1], b: c[2] }
}

impl Core {
    /// Sets the default colours (programs may still override them by OSC).
    fn apply_colors(&self) {
        let Some(colors) = &self.colors else { return };
        // SAFETY: option calls on our terminal, under its lock; values outlive the calls.
        unsafe {
            for (option, color) in [
                (g::GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, colors.foreground),
                (g::GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, colors.background),
                (g::GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, colors.cursor),
            ] {
                let value = color.map(rgb);
                let ptr = value.as_ref().map_or(ptr::null(), |v| (v as *const g::GhosttyColorRgb).cast());
                g::ghostty_terminal_set(self.term, option, ptr);
            }
            let mut palette = [g::GhosttyColorRgb::default(); 256];
            g::ghostty_terminal_get(self.term, g::GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT, palette.as_mut_ptr().cast());
            for (slot, color) in palette.iter_mut().zip(colors.palette) {
                if let Some(c) = color {
                    *slot = rgb(c);
                }
            }
            g::ghostty_terminal_set(self.term, g::GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palette.as_ptr().cast());
        }
    }

    /// The text on the screen and in the scrollback (or in `selection`,
    /// whose refs are valid only under this same lock), soft wraps joined.
    pub fn text(&self, selection: Option<&g::GhosttySelection>) -> String {
        let mut formatter = ptr::null_mut();
        let mut out = String::new();
        // SAFETY: a formatter of our terminal, used and freed under its lock.
        unsafe {
            if g::ghostty_formatter_terminal_new(ptr::null(), &mut formatter, self.term) != g::GHOSTTY_SUCCESS {
                return out;
            }
            let yes = true;
            g::ghostty_formatter_set(formatter, g::GHOSTTY_FORMATTER_OPT_UNWRAP, (&raw const yes).cast());
            if let Some(selection) = selection {
                g::ghostty_formatter_set(formatter, g::GHOSTTY_FORMATTER_OPT_SELECTION, (selection as *const g::GhosttySelection).cast());
            }
            let mut buf: *mut u8 = ptr::null_mut();
            let mut len = 0usize;
            if g::ghostty_formatter_format_alloc(formatter, ptr::null(), &mut buf, &mut len) == g::GHOSTTY_SUCCESS && !buf.is_null() {
                out = String::from_utf8_lossy(std::slice::from_raw_parts(buf, len)).into_owned();
                g::ghostty_free(ptr::null(), buf, len);
            }
            g::ghostty_formatter_free(formatter);
        }
        out
    }

    /// Whether DEC private mode `mode` is set (2004 bracketed paste, 1004 focus).
    pub fn dec_mode(&self, mode: u16) -> bool {
        let mut config = g::GhosttyTerminalModeConfig { mode: mode & 0x7FFF, value: false };
        // SAFETY: a read of our terminal, under its lock.
        unsafe { g::ghostty_terminal_get(self.term, g::GHOSTTY_TERMINAL_DATA_MODE, (&raw mut config).cast()) };
        config.value
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // SAFETY: our terminal, freed once.
        unsafe { g::ghostty_terminal_free(self.term) };
    }
}

pub struct Shared {
    pub id: u32,
    pub core: Mutex<Core>,
    /// The running shell's input queue (its writer thread owns a dup of the
    /// PTY), apart from `core`: libghostty's answers are written from inside
    /// `vt_write`, under the core lock.
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    events: Mutex<Events>,
    event_ready: Condvar,
    wake_pending: AtomicBool,
    /// Whether `read_shell` wakes `nextEvent` on `output` (`true` by default).
    notify_output: AtomicBool,
    /// Whether the user typed into the running shell.
    used: AtomicBool,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static SESSIONS: LazyLock<Mutex<HashMap<u32, Weak<Shared>>>> = LazyLock::new(Default::default);
/// The view's redraw for a session id, run on the main thread (none headless).
static WAKE: OnceLock<fn(u32)> = OnceLock::new();

/// A live session by id (the view's `session` prop).
pub fn find(id: u32) -> Option<Arc<Shared>> {
    SESSIONS.lock().unwrap().get(&id).and_then(Weak::upgrade)
}

/// Sets what `Shared::changed` runs on the main thread.
pub fn on_change(wake: fn(u32)) {
    let _ = WAKE.set(wake);
}

unsafe extern "C" fn on_write_pty(_t: g::GhosttyTerminal, user: *mut libc::c_void, data: *const u8, len: usize) {
    // SAFETY: userdata is the `Shared` that owns the terminal; data is len bytes.
    let shared = unsafe { &*(user as *const Shared) };
    if !data.is_null() && len > 0 {
        shared.send(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
    }
}

unsafe extern "C" fn on_title(term: g::GhosttyTerminal, user: *mut libc::c_void) {
    // SAFETY: as in `on_write_pty`; the title string is read at once.
    let shared = unsafe { &*(user as *const Shared) };
    let mut title = g::GhosttyString::default();
    let ok = unsafe { g::ghostty_terminal_get(term, g::GHOSTTY_TERMINAL_DATA_TITLE, (&raw mut title).cast()) };
    if ok == g::GHOSTTY_SUCCESS && !title.ptr.is_null() {
        let bytes = unsafe { std::slice::from_raw_parts(title.ptr, title.len) };
        let clean: String = String::from_utf8_lossy(bytes).chars().filter(|c| !c.is_control()).take(200).collect();
        shared.notify(|e| e.title = Some(clean.trim().to_owned()));
    }
}

fn new_terminal(rows: u16, cols: u16) -> g::GhosttyTerminal {
    let mut term = ptr::null_mut();
    // SAFETY: plain creation and option calls on our new terminal.
    unsafe {
        g::ghostty_terminal_new(ptr::null(), &mut term, cols, rows);
        assert!(!term.is_null(), "libghostty-vt: no terminal");
        g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, (&raw const SCROLLBACK_LINES).cast());
        let name = "xterm-256color";
        let s = g::GhosttyString { ptr: name.as_ptr(), len: name.len() };
        g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_TERMINFO_NAME, (&raw const s).cast());
        g::ghostty_terminal_resize(term, cols, rows, CELL_W, CELL_H);
    }
    term
}

impl Shared {
    fn new(rows: u16, cols: u16) -> Arc<Shared> {
        let shared = Arc::new(Shared {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            core: Mutex::new(Core {
                term: new_terminal(rows, cols),
                rows,
                cols,
                cell_w: CELL_W,
                cell_h: CELL_H,
                run: None,
                colors: None,
                generation: 0,
            }),
            input: Mutex::new(None),
            events: Mutex::new(Events::default()),
            event_ready: Condvar::new(),
            wake_pending: AtomicBool::new(false),
            notify_output: AtomicBool::new(true),
            used: AtomicBool::new(false),
        });
        let term = shared.core.lock().unwrap().term;
        let user = Arc::as_ptr(&shared) as *const libc::c_void;
        let write_pty: unsafe extern "C" fn(g::GhosttyTerminal, *mut libc::c_void, *const u8, usize) = on_write_pty;
        let title: unsafe extern "C" fn(g::GhosttyTerminal, *mut libc::c_void) = on_title;
        // SAFETY: the callbacks get `user`, which lives as long as the terminal
        // (both are dropped with this `Shared`).
        unsafe {
            g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_USERDATA, user);
            g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_WRITE_PTY, write_pty as *const libc::c_void);
            g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, title as *const libc::c_void);
        }
        SESSIONS.lock().unwrap().insert(shared.id, Arc::downgrade(&shared));
        shared
    }

    /// Bytes for the running shell; dropped when none runs.
    pub fn send(&self, bytes: Vec<u8>) {
        log::line(|| format!("#{} report {}", self.id, log::escape(&bytes)));
        if let Some(input) = self.input.lock().unwrap().as_ref() {
            let _ = input.send(bytes);
        }
    }

    /// What the user typed (keys, paste, mouse): it marks the shell used;
    /// with no shell, TSX hears `input` (and starts one).
    pub fn type_in(&self, bytes: Vec<u8>) {
        if log::on() {
            let shown = if self.reads_password() { format!("<{} bytes hidden: password prompt>", bytes.len()) } else { log::escape(&bytes) };
            log::line(|| format!("#{} type {shown}", self.id));
        }
        let input = self.input.lock().unwrap();
        match input.as_ref() {
            Some(tx) => {
                self.used.store(true, Ordering::Relaxed);
                let _ = tx.send(bytes);
            }
            None => {
                drop(input);
                self.notify(|e| e.input = true);
            }
        }
    }

    pub fn running(&self) -> bool {
        self.input.lock().unwrap().is_some()
    }

    /// A program reads a password: keys stay out of the log.
    pub fn reads_password(&self) -> bool {
        self.core.lock().unwrap().run.as_ref().is_some_and(|run| pty::reads_password(run.child.fd))
    }

    fn notify(&self, change: impl FnOnce(&mut Events)) {
        change(&mut self.events.lock().unwrap());
        self.event_ready.notify_all();
    }

    /// The screen changed: the view redraws (once per main-queue turn).
    pub fn changed(&self) {
        let Some(&wake) = WAKE.get() else { return };
        if !self.wake_pending.swap(true, Ordering::AcqRel) {
            let id = self.id;
            dispatch2::DispatchQueue::main().exec_async(move || wake(id));
        }
    }

    /// The view is redrawing: later changes schedule another redraw.
    pub fn woken(&self) {
        self.wake_pending.store(false, Ordering::Release);
    }

    pub fn set_notify_output(&self, on: bool) {
        self.notify_output.store(on, Ordering::Release);
        if !on {
            self.events.lock().unwrap().output = false;
        }
    }

    /// Writes to the terminal's screen (not to the shell).
    pub fn vt_write(&self, bytes: &[u8]) {
        let core = self.core.lock().unwrap();
        // SAFETY: our terminal, under its lock.
        unsafe { g::ghostty_terminal_vt_write(core.term, bytes.as_ptr(), bytes.len()) };
        drop(core);
        self.changed();
    }

    /// Resizes the terminal and the running shell's PTY.
    pub fn resize(&self, rows: u16, cols: u16, cell_w: u32, cell_h: u32) {
        let mut core = self.core.lock().unwrap();
        if (core.rows, core.cols, core.cell_w, core.cell_h) == (rows, cols, cell_w, cell_h) {
            return;
        }
        (core.rows, core.cols, core.cell_w, core.cell_h) = (rows, cols, cell_w, cell_h);
        // SAFETY: our terminal, under its lock.
        unsafe { g::ghostty_terminal_resize(core.term, cols, rows, cell_w.max(1), cell_h.max(1)) };
        if let Some(run) = &core.run {
            pty::set_size(run.child.fd, rows, cols);
        }
        drop(core);
        log::line(|| format!("#{} resize {rows}x{cols} cell {cell_w}x{cell_h}px", self.id));
        self.changed();
    }

    fn start(self: &Arc<Self>, spec: &pty::ShellSpec) -> std::io::Result<()> {
        self.stop();
        let mut core = self.core.lock().unwrap();
        let child = pty::spawn(&pty::ShellSpec { rows: core.rows, cols: core.cols, ..*spec }).inspect_err(|e| {
            log::line(|| format!("#{} start {} in {} failed: {e}", self.id, spec.shell, spec.cwd));
        })?;
        log::line(|| format!("#{} start {} in {} pid {} at {}x{}", self.id, spec.shell, spec.cwd, child.pid, core.rows, core.cols));
        core.generation += 1;
        let generation = core.generation;
        core.run = Some(Run { child });
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        *self.input.lock().unwrap() = Some(tx);
        self.used.store(false, Ordering::Relaxed);
        drop(core);
        let wfd = pty::dup(child.fd);
        std::thread::Builder::new()
            .name("aed-pty-writer".into())
            .spawn(move || {
                for bytes in rx {
                    pty::write_all(wfd, &bytes);
                }
                pty::close(wfd);
            })?;
        let shared = self.clone();
        std::thread::Builder::new()
            .name("aed-pty-reader".into())
            .spawn(move || shared.read_shell(child, generation))?;
        Ok(())
    }

    /// The reader thread: the shell's output into the terminal until it ends.
    fn read_shell(&self, child: pty::Child, generation: u64) {
        let mut buf = vec![0u8; 1 << 16];
        while let Some(n) = pty::read(child.fd, &mut buf) {
            let core = self.core.lock().unwrap();
            if core.generation != generation {
                break;
            }
            // SAFETY: our terminal, under its lock.
            unsafe { g::ghostty_terminal_vt_write(core.term, buf.as_ptr(), n) };
            drop(core);
            log::line(|| format!("#{} output {n} {}", self.id, log::escape(&buf[..n.min(240)])));
            if self.notify_output.load(Ordering::Acquire) {
                self.notify(|e| e.output = true);
            }
            self.changed();
        }
        let mut core = self.core.lock().unwrap();
        let current = core.generation == generation;
        if current {
            core.run = None;
            *self.input.lock().unwrap() = None;
        }
        // Closed under the lock: `resize` uses the fd only while `run` has it.
        pty::close(child.fd);
        drop(core);
        let code = pty::wait(child.pid);
        log::line(|| format!("#{} exit {code}{}", self.id, if current { "" } else { " (replaced)" }));
        if current {
            self.notify(|e| e.exit = Some(code));
        }
    }

    /// Hangs up the running shell; its reader ends without an exit event.
    fn stop(&self) {
        let mut core = self.core.lock().unwrap();
        core.generation += 1;
        if let Some(run) = core.run.take() {
            pty::hang_up(run.child.pid);
            *self.input.lock().unwrap() = None;
        }
    }

    /// Blocks until there is something to tell TSX.
    fn wait_event(&self) -> SessionEvent {
        let mut events = self.events.lock().unwrap();
        loop {
            if events.closed {
                return SessionEvent::kind("closed");
            }
            if let Some(title) = events.title.take() {
                return SessionEvent { title: Some(title), ..SessionEvent::kind("title") };
            }
            if std::mem::take(&mut events.output) {
                return SessionEvent::kind("output");
            }
            if let Some(code) = events.exit.take() {
                return SessionEvent { code: Some(code), ..SessionEvent::kind("exit") };
            }
            if std::mem::take(&mut events.input) {
                return SessionEvent::kind("input");
            }
            events = self.event_ready.wait(events).unwrap();
        }
    }

    fn close(&self) {
        self.stop();
        self.notify(|e| e.closed = true);
        SESSIONS.lock().unwrap().remove(&self.id);
    }

    /// The theme's colours, kept across `reset`.
    pub fn set_colors(&self, colors: &Colors) {
        let mut core = self.core.lock().unwrap();
        if core.colors.as_ref() == Some(colors) {
            return;
        }
        core.colors = Some(colors.clone());
        core.apply_colors();
        drop(core);
        self.changed();
    }

    /// ⌘K: scrollback and the rows above the cursor go; the cursor's row
    /// (the prompt) moves to the top. Ghostty's `clear_screen` outside a
    /// marked prompt.
    fn clear(&self) {
        let core = self.core.lock().unwrap();
        let (mut x, mut y) = (0u16, 0u16);
        let mut alt = 0u32;
        // SAFETY: reads of our terminal, under its lock.
        unsafe {
            g::ghostty_terminal_get(core.term, g::GHOSTTY_TERMINAL_DATA_CURSOR_X, (&raw mut x).cast());
            g::ghostty_terminal_get(core.term, g::GHOSTTY_TERMINAL_DATA_CURSOR_Y, (&raw mut y).cast());
            g::ghostty_terminal_get(core.term, g::GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, (&raw mut alt).cast());
        }
        drop(core);
        if alt != g::GHOSTTY_TERMINAL_SCREEN_PRIMARY {
            return;
        }
        let scroll = if y > 0 { format!("\x1b[{y}S\x1b[1;{}H", x + 1) } else { String::new() };
        self.vt_write(format!("{scroll}\x1b[3J").as_bytes());
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.stop();
    }
}

/// How `TerminalSession.start` runs a shell.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ShellOptions {
    /// The shell's executable (`/bin/zsh`); it runs as a login shell.
    shell: String,
    /// The directory it starts in.
    cwd: String,
    /// Its `TERM_PROGRAM`.
    term_program: String,
    /// Its `GHOSTTY_RESOURCES_DIR` ("" for none).
    resources_dir: String,
}

/// Something that happened in a session, for `TerminalSession.nextEvent`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct SessionEvent {
    /// `output` (the shell wrote; coalesced), `title` (OSC 0/2), `exit`
    /// (the shell ended), `input` (keys came while no shell ran) or `closed`
    /// (`close` was called; no more events).
    kind: String,
    /// The new title, for `title`.
    title: Option<String>,
    /// The shell's exit code (128+n for signal n), for `exit`.
    code: Option<i32>,
}

impl SessionEvent {
    fn kind(kind: &str) -> SessionEvent {
        SessionEvent { kind: kind.into(), ..Default::default() }
    }
}

fn clamp_size(rows: u32, cols: u32) -> (u16, u16) {
    (rows.clamp(1, MAX_ROWS) as u16, cols.clamp(1, MAX_COLS) as u16)
}

/// A terminal tab: libghostty-vt's screen, scrollback and modes, and the
/// login shell running on its PTY (one at a time; a new one keeps the
/// screen). The `aed.terminal` view shows the session whose `id` it gets.
#[class]
pub struct TerminalSession {
    shared: Arc<Shared>,
}

#[class]
impl TerminalSession {
    /// An empty terminal of `rows` × `cols` (until a view measures it).
    pub fn new(rows: u32, cols: u32) -> Self {
        let (rows, cols) = clamp_size(rows, cols);
        TerminalSession { shared: Shared::new(rows, cols) }
    }

    /// The id the view's `session` prop takes.
    #[getter]
    pub fn id(&self) -> u32 {
        self.shared.id
    }

    /// Whether a shell runs.
    #[getter]
    pub fn running(&self) -> bool {
        self.shared.running()
    }

    /// Whether the user typed into the running shell (a new shell is not).
    #[getter]
    pub fn used(&self) -> bool {
        self.shared.used.load(Ordering::Relaxed)
    }

    /// Starts a shell (hanging up one that runs) at the terminal's size.
    pub fn start(&self, options: ShellOptions) -> Result<(), String> {
        let spec = pty::ShellSpec {
            shell: &options.shell,
            cwd: &options.cwd,
            term_program: &options.term_program,
            resources_dir: &options.resources_dir,
            rows: 0,
            cols: 0,
        };
        self.shared.start(&spec).map_err(|e| format!("{}: {e}", options.shell))
    }

    /// Hangs up the shell; it ends without an `exit` event.
    pub fn stop(&self) {
        self.shared.stop();
    }

    /// Input for the shell, as if typed (with none running: an `input` event).
    pub fn write(&self, data: Vec<u8>) {
        self.shared.type_in(data);
    }

    /// Text onto the screen itself (a status line), not to the shell.
    pub fn feed(&self, text: String) {
        self.shared.vt_write(text.as_bytes());
    }

    /// A new size in cells; the shell gets SIGWINCH.
    pub fn resize(&self, rows: u32, cols: u32) {
        let (rows, cols) = clamp_size(rows, cols);
        let (cw, ch) = {
            let core = self.shared.core.lock().unwrap();
            (core.cell_w, core.cell_h)
        };
        self.shared.resize(rows, cols, cw, ch);
    }

    /// ⌘K: the scrollback and the rows above the prompt go.
    pub fn clear(&self) {
        self.shared.clear();
    }

    /// A fresh screen: modes, colours, scrollback and title reset.
    pub fn reset(&self) {
        let core = self.shared.core.lock().unwrap();
        // SAFETY: our terminal, under its lock.
        unsafe { g::ghostty_terminal_reset(core.term) };
        core.apply_colors();
        drop(core);
        self.shared.changed();
    }

    /// The screen and scrollback as plain text, soft-wrapped lines joined.
    pub fn screen_text(&self) -> String {
        self.shared.core.lock().unwrap().text(None)
    }

    /// The next thing that happened; resolves `closed` after `close`.
    pub async fn next_event(this: Instance<Self>) -> SessionEvent {
        let shared = this.with(|s| s.shared.clone());
        blocking(move || shared.wait_event()).await.unwrap_or_else(|_| SessionEvent::kind("closed"))
    }

    /// Hangs up the shell and ends `nextEvent`; the tab is gone.
    pub fn close(&self) {
        self.shared.close();
    }

    /// Whether shell output wakes `nextEvent` with `output` (`true` by default;
    /// `title`, `exit`, `input` and `closed` always wake).
    pub fn set_notify_output(&self, on: bool) {
        self.shared.set_notify_output(on);
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.shared.close();
    }
}

#[cfg(test)]
mod tests;
