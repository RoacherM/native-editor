//! `aed.terminal`: the NSView that shows a `TerminalSession` and types into
//! it. Keys and the IME (NSTextInputClient), mouse selection, the clipboard,
//! scrolling, ⌘-click links and focus reports; drawing is `grid`'s.
//! DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」.

use std::{
    cell::{RefCell, RefMut},
    collections::HashMap,
    ptr,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::JsonValue;
use nsh_platform_macos::{ComponentContext, NativeComponent};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, NSObjectProtocol, Sel},
};
use objc2_app_kit::{
    NSCursor, NSEvent, NSEventModifierFlags, NSGraphicsContext, NSPasteboard, NSPasteboardTypeString, NSResponder,
    NSTextInputClient, NSView,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSAttributedString, NSAttributedStringKey, NSNotFound, NSObject, NSPoint, NSRange, NSRect, NSSize, NSString};

use crate::{
    ffi as g,
    grid::{self, Changed, Fonts, Frame, Grid, Look, PAD_X, PAD_Y, Render, Rgba},
    keys, log,
    session::{self, Colors, Core, Shared},
};

const DEFAULT_FONT_SIZE: f64 = 12.0;
const DEFAULT_SELECTION: Rgba = Rgba([0x80, 0x80, 0x80, 0x60]);
const CURSOR_LOG_WINDOW: Duration = Duration::from_millis(1500);

thread_local! {
    /// The view showing each session, by session id.
    static VIEWS: RefCell<HashMap<u32, Weak<TermView>>> = RefCell::new(HashMap::new());
}

/// `Shared::changed`'s main-thread half: coalesces display invalidation for the session's view.
pub fn wake(id: u32) {
    let view = VIEWS.with(|v| v.borrow().get(&id).and_then(Weak::load));
    match view {
        Some(view) => view.on_session_wake(),
        None => {
            if let Some(shared) = session::find(id) {
                shared.woken();
            }
        }
    }
}

/// Pure IME composition state (`NSTextInputClient`), isolated per focus & session.
#[derive(Debug, Default, Clone, PartialEq)]
struct ImeState {
    marked: Option<String>,
    selected: NSRange,
}

impl ImeState {
    fn set_marked(&mut self, text: String, selected: NSRange) {
        if text.is_empty() {
            self.clear();
        } else {
            self.marked = Some(text);
            self.selected = selected;
        }
    }

    /// Clears active preedit; returns whether marked text was active.
    fn clear(&mut self) -> bool {
        self.selected = NSRange::new(0, 0);
        self.marked.take().is_some()
    }

    fn selected_range(&self) -> NSRange {
        if self.marked.is_some() { self.selected } else { NSRange::new(0, 0) }
    }

    fn marked_range(&self) -> NSRange {
        match &self.marked {
            Some(text) => NSRange::new(0, utf16_len(text)),
            None => NSRange::new(NSNotFound as usize, 0),
        }
    }

    fn has_marked(&self) -> bool {
        self.marked.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeAction {
    /// First wake in this display cycle: sync dirty rows now and mark only their rects.
    SyncDirty,
    /// Additional wake before `drawRect:` ran: defer sync to `drawRect:` and mark full bounds once.
    CoalesceFull,
    /// Already coalescing (or view is hidden/unmounted): hold `wake_pending` with zero work.
    Hold,
}

/// Display-cycle coalescer: preserves dirty-row clipping on idle cursor blinks
/// while collapsing burst PTY chunks within one 60/120Hz frame into a single
/// `render.sync` right before `drawRect:` paints.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DisplaySync {
    awaiting_draw: bool,
    deferred_sync: bool,
}

impl DisplaySync {
    fn on_wake(&mut self, drawable: bool) -> WakeAction {
        if !drawable {
            self.awaiting_draw = false;
        } else if !self.awaiting_draw && !self.deferred_sync {
            return WakeAction::SyncDirty;
        }
        if !self.deferred_sync {
            self.deferred_sync = true;
            return WakeAction::CoalesceFull;
        }
        WakeAction::Hold
    }

    fn did_invalidate(&mut self) {
        self.awaiting_draw = true;
    }

    /// Runs at the start of `drawRect:`; returns whether a deferred sync is due.
    fn on_draw(&mut self) -> bool {
        self.awaiting_draw = false;
        std::mem::take(&mut self.deferred_sync)
    }
}

/// Sorts, deduplicates and merges dirty row indices into `(start_row, row_count)` spans.
fn row_spans(mut rows: Vec<u16>) -> Vec<(u16, u16)> {
    rows.sort_unstable();
    rows.dedup();
    let mut spans: Vec<(u16, u16)> = Vec::new();
    for y in rows {
        match spans.last_mut() {
            Some((start, len)) if *start + *len == y => *len += 1,
            _ => spans.push((y, 1)),
        }
    }
    spans
}

/// Rect for a dirty row span when it intersects the view's `0..width × 0..height` bounds.
fn visible_row_rect(frame: &Frame, width: f64, start: u16, count: u16) -> Option<CGRect> {
    let bottom_row = start + count - 1;
    let y = frame.row_top(bottom_row);
    let h = count as f64 * frame.cell_h;
    (width > 0.0 && h > 0.0 && y < frame.height && y + h > 0.0).then(|| CGRect::new(CGPoint::new(0.0, y), CGSize::new(width, h)))
}

fn should_log_cursor_row(log_on: bool, typed_at: Option<Instant>, now: Instant) -> bool {
    log_on && typed_at.is_some_and(|t| now.saturating_duration_since(t) <= CURSOR_LOG_WINDOW)
}

/// libghostty's encoders and event objects (not tied to a terminal).
struct Io {
    key_encoder: g::GhosttyKeyEncoder,
    key: g::GhosttyKeyEvent,
    mouse_encoder: g::GhosttyMouseEncoder,
    mouse: g::GhosttyMouseEvent,
    /// Selection gesture events: press, release, drag (types are fixed).
    press: g::GhosttySelectionGestureEvent,
    release: g::GhosttySelectionGestureEvent,
    drag: g::GhosttySelectionGestureEvent,
}

impl Io {
    fn new() -> Io {
        let mut io = Io {
            key_encoder: ptr::null_mut(),
            key: ptr::null_mut(),
            mouse_encoder: ptr::null_mut(),
            mouse: ptr::null_mut(),
            press: ptr::null_mut(),
            release: ptr::null_mut(),
            drag: ptr::null_mut(),
        };
        // SAFETY: creation of our own handles.
        unsafe {
            g::ghostty_key_encoder_new(ptr::null(), &mut io.key_encoder);
            g::ghostty_key_event_new(ptr::null(), &mut io.key);
            g::ghostty_mouse_encoder_new(ptr::null(), &mut io.mouse_encoder);
            g::ghostty_mouse_event_new(ptr::null(), &mut io.mouse);
            g::ghostty_selection_gesture_event_new(ptr::null(), &mut io.press, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS);
            g::ghostty_selection_gesture_event_new(ptr::null(), &mut io.release, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE);
            g::ghostty_selection_gesture_event_new(ptr::null(), &mut io.drag, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG);
        }
        io
    }
}

impl Drop for Io {
    fn drop(&mut self) {
        // SAFETY: our handles, freed once.
        unsafe {
            g::ghostty_key_event_free(self.key);
            g::ghostty_key_encoder_free(self.key_encoder);
            g::ghostty_mouse_event_free(self.mouse);
            g::ghostty_mouse_encoder_free(self.mouse_encoder);
            for event in [self.press, self.release, self.drag] {
                g::ghostty_selection_gesture_event_free(event);
            }
        }
    }
}

/// The session a view shows, with the selection gesture state kept for its
/// terminal.
struct Bound {
    shared: Arc<Shared>,
    gesture: g::GhosttySelectionGesture,
}

impl Drop for Bound {
    fn drop(&mut self) {
        let core = self.shared.core.lock().unwrap();
        // SAFETY: the gesture of this terminal, freed once under its lock.
        unsafe { g::ghostty_selection_gesture_free(self.gesture, core.term) };
    }
}

pub struct State {
    cx: Option<ComponentContext>,
    bound: Option<Bound>,
    render: Render,
    grid: Grid,
    display: DisplaySync,
    fonts: Fonts,
    family: Option<String>,
    size: f64,
    colors: Colors,
    selection: Rgba,
    ime: ImeState,
    /// Text `insertText:` gave during the current `keyDown:`.
    typed: Option<Vec<String>>,
    focused: bool,
    /// Whether the left button's press went to the program (mouse tracking).
    reporting: bool,
    /// Precise (trackpad) scroll not yet a whole line.
    scroll: f64,
    /// When the user last typed: the log shows the cursor row as it redraws.
    typed_at: Option<Instant>,
    io: Io,
}

impl State {
    fn shared(&self) -> Option<Arc<Shared>> {
        self.bound.as_ref().map(|b| b.shared.clone())
    }
}

/// What the IME and the event handlers need of a key.
struct Key<'a> {
    code: u16,
    mods: g::GhosttyMods,
    repeat: bool,
    text: Option<&'a str>,
    unshifted: u32,
}

impl Key<'_> {
    fn of(event: &NSEvent) -> Key<'static> {
        let unshifted = event
            .charactersIgnoringModifiers()
            .and_then(|s| s.to_string().chars().next())
            .filter(|c| keys::printable(&c.to_string()))
            .map_or(0, |c| c.to_ascii_lowercase() as u32);
        Key { code: event.keyCode(), mods: keys::mods(event.modifierFlags()), repeat: event.isARepeat(), text: None, unshifted }
    }
}

/// Encodes `key` for the terminal's current modes.
///
/// # Safety
/// `core` is locked; `io` is not used elsewhere meanwhile.
unsafe fn encode_key(io: &Io, core: &Core, key: g::GhosttyKey, k: &Key) -> Vec<u8> {
    let mut out = [0u8; 128];
    let mut n = 0usize;
    let none = g::GhosttyString { ptr: ptr::null(), len: 0 };
    unsafe {
        g::ghostty_key_encoder_set_from_terminal(io.key_encoder, core.term);
        let option_as_alt = g::GHOSTTY_OPTION_AS_ALT_FALSE;
        g::ghostty_key_encoder_set(io.key_encoder, g::GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT, (&raw const option_as_alt).cast());
        let action = if k.repeat { g::GHOSTTY_KEY_ACTION_REPEAT } else { g::GHOSTTY_KEY_ACTION_PRESS };
        g::ghostty_key_event_set_action(io.key, action);
        g::ghostty_key_event_set_key(io.key, key);
        g::ghostty_key_event_set_mods(io.key, k.mods);
        let text = k.text.filter(|t| keys::printable(t));
        // The text already carries Shift and Option.
        let consumed = if text.is_some() { k.mods & (g::GHOSTTY_MODS_SHIFT | g::GHOSTTY_MODS_ALT) as g::GhosttyMods } else { 0 };
        g::ghostty_key_event_set_consumed_mods(io.key, consumed);
        g::ghostty_key_event_set_utf8(io.key, text.map_or(none, |t| g::GhosttyString { ptr: t.as_ptr(), len: t.len() }));
        g::ghostty_key_event_set_unshifted_codepoint(io.key, k.unshifted);
        g::ghostty_key_event_set_composing(io.key, false);
        let done = g::ghostty_key_encoder_encode(io.key_encoder, io.key, out.as_mut_ptr(), out.len(), &mut n);
        g::ghostty_key_event_set_utf8(io.key, none);
        // Nothing rather than part of a sequence.
        if done != g::GHOSTTY_SUCCESS {
            return Vec::new();
        }
    }
    out[..n.min(out.len())].to_vec()
}

/// The options a gesture event of `kind` takes: press, where and when
/// (multi-click); drag, where and the grid (autoscroll); release, the cell.
///
/// # Safety
/// `event` is the gesture event for `kind`; the values outlive its use.
unsafe fn set_gesture_event(
    event: g::GhosttySelectionGestureEvent,
    kind: g::GhosttySelectionGestureEventType,
    cell: &g::GhosttyGridRef,
    position: &g::GhosttySurfacePosition,
    time_ns: u64,
    geometry: &g::GhosttySelectionGestureGeometry,
) {
    let set = |option, value: *const libc::c_void| unsafe { g::ghostty_selection_gesture_event_set(event, option, value) };
    set(g::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, (cell as *const g::GhosttyGridRef).cast());
    let extra = match kind {
        g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS => (g::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS, (&raw const time_ns).cast()),
        g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG => {
            (g::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, (geometry as *const g::GhosttySelectionGestureGeometry).cast())
        }
        _ => return,
    };
    set(g::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, (position as *const g::GhosttySurfacePosition).cast());
    set(extra.0, extra.1);
}

/// A gesture's selection onto the screen; a press that selects nothing (a
/// plain click) clears the old one.
///
/// # Safety
/// `term` is locked by the caller.
unsafe fn show_selection(term: g::GhosttyTerminal, selection: Option<&g::GhosttySelection>, kind: g::GhosttySelectionGestureEventType) {
    if selection.is_none() && kind != g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS {
        return;
    }
    let value = selection.map_or(ptr::null(), |s| (s as *const g::GhosttySelection).cast());
    unsafe { g::ghostty_terminal_set(term, g::GHOSTTY_TERMINAL_OPT_SELECTION, value) };
}

/// Scrolls the viewport back to the prompt (typing or pasting).
///
/// # Safety
/// `core` is locked.
unsafe fn scroll_to_bottom(core: &Core) {
    let behavior = g::GhosttyTerminalScrollViewport { tag: g::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM, value: Default::default() };
    unsafe { g::ghostty_terminal_scroll_viewport(core.term, behavior) };
}

fn get<T: Default>(core: &Core, data: g::GhosttyTerminalData) -> T {
    let mut out = T::default();
    // SAFETY: `data` is of type T; `core` is locked by its caller.
    unsafe { g::ghostty_terminal_get(core.term, data, (&raw mut out).cast()) };
    out
}

fn ns_text(obj: &AnyObject) -> String {
    if let Some(s) = obj.downcast_ref::<NSAttributedString>() {
        s.string().to_string()
    } else if let Some(s) = obj.downcast_ref::<NSString>() {
        s.to_string()
    } else {
        String::new()
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A pointer event, in libghostty's surface pixels and the grid's cells.
struct Pointer {
    x: f64,
    y: f64,
    col: u16,
    row: u16,
    mods: g::GhosttyMods,
    time_ns: u64,
}

pub struct Ivars {
    state: RefCell<State>,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AedTerminalView"]
    #[ivars = Ivars]
    pub struct TermView;

    impl TermView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            false
        }

        #[unsafe(method(isOpaque))]
        fn is_opaque(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            let ok: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if ok {
                self.set_focused(true);
            }
            ok
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            let ok: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if ok {
                self.discard_ime();
                self.set_focused(false);
            }
            ok
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, rect: NSRect) {
            self.draw(rect);
        }

        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: NSSize) {
            let _: () = unsafe { msg_send![super(self), setFrameSize: size] };
            self.fit();
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn view_did_move_to_window(&self) {
            self.set_font();
        }

        #[unsafe(method(viewDidChangeBackingProperties))]
        fn view_did_change_backing_properties(&self) {
            self.set_font();
        }

        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            self.addCursorRect_cursor(self.bounds(), &NSCursor::IBeamCursor());
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.key(event);
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.press(event);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.drag(event);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.release(event);
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            self.scroll(event);
        }

        #[unsafe(method(copy:))]
        fn copy(&self, _sender: Option<&AnyObject>) {
            self.copy_selection();
        }

        #[unsafe(method(paste:))]
        fn paste(&self, _sender: Option<&AnyObject>) {
            self.paste_clipboard();
        }

        #[unsafe(method(selectAll:))]
        fn select_all(&self, _sender: Option<&AnyObject>) {
            self.select_everything();
        }
    }

    unsafe impl NSObjectProtocol for TermView {}

    unsafe impl NSTextInputClient for TermView {
        #[unsafe(method(insertText:replacementRange:))]
        fn insert_text(&self, string: &AnyObject, range: NSRange) {
            let text = ns_text(string);
            self.log_input(|| format!("ime insert {:?} replace {range:?}", text));
            let mut st = self.state();
            st.ime.clear();
            match st.typed.as_mut() {
                Some(typed) => typed.push(text),
                // Not from a key (the character viewer): straight to the shell.
                None => {
                    drop(st);
                    self.send_text(&text);
                }
            }
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(doCommandBySelector:))]
        fn do_command_by_selector(&self, selector: Sel) {
            // Enter, arrows, Backspace…: `key` encodes them itself.
            log::line(|| format!("ime command {}", selector.name().to_string_lossy()));
        }

        #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
        fn set_marked_text(&self, string: &AnyObject, selected: NSRange, replacement: NSRange) {
            let text = ns_text(string);
            self.log_input(|| format!("ime mark {text:?} selected {selected:?} replace {replacement:?}"));
            self.state().ime.set_marked(text, selected);
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(unmarkText))]
        fn unmark_text(&self) {
            log::line(|| "ime unmark".into());
            self.state().ime.clear();
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(selectedRange))]
        fn selected_range(&self) -> NSRange {
            self.state().ime.selected_range()
        }

        #[unsafe(method(markedRange))]
        fn marked_range(&self) -> NSRange {
            self.state().ime.marked_range()
        }

        #[unsafe(method(hasMarkedText))]
        fn has_marked_text(&self) -> bool {
            self.state().ime.has_marked()
        }

        #[unsafe(method(attributedSubstringForProposedRange:actualRange:))]
        fn attributed_substring(&self, _range: NSRange, _actual: *mut NSRange) -> *mut NSAttributedString {
            ptr::null_mut()
        }

        #[unsafe(method(validAttributesForMarkedText))]
        fn valid_attributes_for_marked_text(&self) -> *mut NSArray<NSAttributedStringKey> {
            Retained::autorelease_return(NSArray::new())
        }

        #[unsafe(method(firstRectForCharacterRange:actualRange:))]
        fn first_rect_for_character_range(&self, _range: NSRange, _actual: *mut NSRange) -> NSRect {
            self.cursor_screen_rect()
        }

        #[unsafe(method(characterIndexForPoint:))]
        fn character_index_for_point(&self, _point: NSPoint) -> usize {
            NSNotFound as usize
        }
    }
);

impl TermView {
    fn new(mtm: MainThreadMarker, cx: ComponentContext) -> Retained<TermView> {
        let state = State {
            cx: Some(cx),
            bound: None,
            render: Render::new(),
            grid: Grid::default(),
            display: DisplaySync::default(),
            fonts: Fonts::new(None, DEFAULT_FONT_SIZE, 2.0),
            family: None,
            size: DEFAULT_FONT_SIZE,
            colors: Colors::default(),
            selection: DEFAULT_SELECTION,
            ime: ImeState::default(),
            typed: None,
            focused: false,
            reporting: false,
            scroll: 0.0,
            typed_at: None,
            io: Io::new(),
        };
        let this = TermView::alloc(mtm).set_ivars(Ivars { state: RefCell::new(state) });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: NSRect::ZERO] };
        // Since macOS 14 views do not clip by default, and `drawRect:` gets
        // dirty rects past the bounds: the background fill would paint over
        // the terminal's toolbar and the editor above it.
        view.setClipsToBounds(true);
        view
    }

    fn state(&self) -> RefMut<'_, State> {
        self.ivars().state.borrow_mut()
    }

    /// Clears uncommitted IME composition on focus loss or session switch so
    /// preedit text never leaks into another tab or panel.
    fn discard_ime(&self) {
        let had_marked = self.state().ime.clear();
        if let Some(ctx) = self.inputContext() {
            ctx.discardMarkedText();
        }
        if had_marked {
            self.setNeedsDisplay(true);
        }
    }

    /// Runs `f` with the bound terminal locked.
    fn with_core<R>(&self, f: impl FnOnce(&mut State, &Core) -> R) -> Option<R> {
        let mut st = self.state();
        let shared = st.shared()?;
        let core = shared.core.lock().unwrap();
        Some(f(&mut st, &core))
    }

    /// What the user typed, clicked or pasted, for the shell.
    fn send(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let shared = {
            let mut st = self.state();
            st.typed_at = Some(Instant::now());
            st.shared()
        };
        if let Some(shared) = shared {
            shared.type_in(bytes);
            shared.changed();
        }
    }

    /// Whether a program reads a password: input is not logged.
    fn secret(&self) -> bool {
        self.state().shared().is_some_and(|s| s.reads_password())
    }

    /// An input event for the log, hidden at a password prompt.
    fn log_input(&self, line: impl FnOnce() -> String) {
        if !log::on() {
            return;
        }
        if self.secret() {
            log::line(|| "input <hidden: password prompt>".into());
        } else {
            log::line(line);
        }
    }

    /// After typing: the cursor's row as the screen now has it (cell by
    /// cell, so a wrong glyph or a shifted column shows).
    fn write_cursor_row_log(st: &State) {
        let Some(c) = st.grid.cursor else { return };
        let Some(row) = st.grid.rows.get(c.y as usize) else { return };
        let text: String = row.iter().map(|cell| if cell.text.is_empty() { "·" } else { cell.text.as_str() }).collect();
        let text = text.trim_end_matches(['·', ' ']);
        log::line(|| format!("screen row {} cursor col {}: {text}", c.y, c.x));
    }

    fn send_text(&self, text: &str) {
        self.with_core(|_, core| unsafe { scroll_to_bottom(core) });
        self.send(text.as_bytes().to_vec());
    }

    fn scale(&self) -> f64 {
        self.window().map_or(2.0, |w| w.backingScaleFactor())
    }

    fn frame(&self, fonts: &Fonts) -> Frame {
        Frame { height: self.bounds().size.height, cell_w: fonts.cell_w, cell_h: fonts.cell_h }
    }

    fn is_drawable(&self) -> bool {
        let size = self.bounds().size;
        self.window().is_some() && !self.isHiddenOrHasHiddenAncestor() && size.width >= 1.0 && size.height >= 1.0
    }

    // ------------------------------------------------------------ binding

    /// Shows session `id` (none: an empty view).
    fn bind(&self, id: Option<u32>) {
        if self.state().bound.as_ref().map(|b| b.shared.id) == id {
            return;
        }
        self.discard_ime();
        let mut st = self.state();
        if let Some(old) = st.bound.take() {
            old.shared.woken();
            VIEWS.with(|v| v.borrow_mut().remove(&old.shared.id));
        }
        st.display = DisplaySync::default();
        if let Some(shared) = id.and_then(session::find) {
            VIEWS.with(|v| v.borrow_mut().insert(shared.id, Weak::new(self)));
            let mut gesture = ptr::null_mut();
            // SAFETY: creation of our own handle.
            unsafe { g::ghostty_selection_gesture_new(ptr::null(), &mut gesture) };
            if st.colors != Colors::default() {
                shared.set_colors(&st.colors);
            }
            st.bound = Some(Bound { shared, gesture });
            // A new terminal: every row is read again.
            st.grid = Grid::default();
        }
        drop(st);
        self.fit();
        self.refresh();
        self.setNeedsDisplay(true);
    }

    fn set_font(&self) {
        let scale = self.scale();
        let mut st = self.state();
        st.fonts = Fonts::new(st.family.as_deref(), st.size, scale);
        drop(st);
        self.fit();
        self.setNeedsDisplay(true);
    }

    fn set_theme(&self, theme: Option<&JsonValue>) {
        let color = |key: &str| theme.and_then(|t| t.get(key)).and_then(JsonValue::as_str).and_then(Rgba::parse);
        let mut colors = Colors {
            foreground: color("foreground").map(Rgba::rgb),
            background: color("background").map(Rgba::rgb),
            cursor: color("cursor").map(Rgba::rgb),
            palette: [None; 16],
        };
        if let Some(palette) = theme.and_then(|t| t.get("palette")).and_then(JsonValue::as_array) {
            for (slot, value) in colors.palette.iter_mut().zip(palette) {
                *slot = value.as_str().and_then(Rgba::parse).map(Rgba::rgb);
            }
        }
        let mut st = self.state();
        st.selection = color("selection").unwrap_or(DEFAULT_SELECTION);
        st.colors = colors.clone();
        let shared = st.shared();
        drop(st);
        if let Some(shared) = shared {
            shared.set_colors(&colors);
        }
        self.setNeedsDisplay(true);
    }

    /// Sizes the terminal to the view.
    fn fit(&self) {
        let size = self.bounds().size;
        let st = self.state();
        let Some(shared) = st.shared() else { return };
        if size.width < 1.0 || size.height < 1.0 {
            return;
        }
        let fit = |space: f64, pad: f64, cell: f64, max: f64| ((space - 2.0 * pad) / cell).floor().clamp(1.0, max) as u16;
        let cols = fit(size.width, PAD_X, st.fonts.cell_w, 1000.0).max(2);
        let rows = fit(size.height, PAD_Y, st.fonts.cell_h, 500.0);
        let (cw, ch) = st.fonts.cell_px();
        drop(st);
        shared.resize(rows, cols, cw, ch);
    }

    /// Snapshot what changed in the bound session into `st.grid`, releasing
    /// `wake_pending` so later PTY writes schedule the next display cycle.
    fn sync_grid(st: &mut State, shared: &Shared) -> Changed {
        st.display.deferred_sync = false;
        shared.woken();
        let changed = {
            let core = shared.core.lock().unwrap();
            // SAFETY: the terminal is locked.
            unsafe { st.render.sync(core.term, &mut st.grid) }
        };
        if !matches!(changed, Changed::None)
            && should_log_cursor_row(log::on(), st.typed_at, Instant::now())
            && !shared.reads_password()
        {
            Self::write_cursor_row_log(st);
        }
        changed
    }

    /// Coalesced wakeup from `Shared::changed`: syncs dirty rows once for the
    /// first chunk in a display cycle (preserving single-row clipping on
    /// cursor blinks) and defers any further chunks in the same frame to
    /// `drawRect:` while holding `wake_pending`.
    fn on_session_wake(&self) {
        let drawable = self.is_drawable();
        let action = self.state().display.on_wake(drawable);
        match action {
            WakeAction::SyncDirty => self.refresh(),
            WakeAction::CoalesceFull => self.setNeedsDisplay(true),
            WakeAction::Hold => {}
        }
    }

    /// Reads what changed in the terminal and marks only the dirty row spans
    /// (or full bounds) for drawing.
    fn refresh(&self) {
        let mut st = self.state();
        let Some(shared) = st.shared() else { return };
        let st = &mut *st;
        let changed = Self::sync_grid(st, &shared);
        let frame = self.frame(&st.fonts);
        let width = self.bounds().size.width;
        match changed {
            Changed::None => {}
            Changed::All => {
                if self.is_drawable() {
                    st.display.did_invalidate();
                }
                self.setNeedsDisplay(true);
            }
            Changed::Rows(rows) => {
                let mut any_visible = false;
                for (start, count) in row_spans(rows) {
                    if let Some(rect) = visible_row_rect(&frame, width, start, count) {
                        any_visible = true;
                        self.setNeedsDisplayInRect(rect);
                    }
                }
                if any_visible && self.is_drawable() {
                    st.display.did_invalidate();
                }
            }
        }
    }

    fn draw(&self, dirty: NSRect) {
        let Ok(mut st) = self.ivars().state.try_borrow_mut() else { return };
        let Some(ns) = NSGraphicsContext::currentContext() else { return };
        let ctx = ns.CGContext();
        let st = &mut *st;
        let need_sync = st.display.on_draw();
        let Some(shared) = st.shared() else {
            let bg = st.colors.background.unwrap_or([0, 0, 0]);
            grid::fill(&ctx, bg, dirty);
            return;
        };
        if need_sync {
            Self::sync_grid(st, &shared);
        }
        let frame = self.frame(&st.fonts);
        let look = Look { focused: st.focused, selection: Some(st.selection), marked: st.ime.marked.clone() };
        st.grid.draw(&ctx, &mut st.fonts, &frame, dirty, &look);
    }

    fn set_focused(&self, focused: bool) {
        log::line(|| format!("focus {focused}"));
        let mut st = self.state();
        st.focused = focused;
        if let Some(cx) = &st.cx {
            cx.emit("focused", serde_json::json!({ "focused": focused }));
        }
        drop(st);
        let report = self.with_core(|_, core| {
            if !core.dec_mode(1004) {
                return Vec::new();
            }
            let event = if focused { g::GHOSTTY_FOCUS_GAINED } else { g::GHOSTTY_FOCUS_LOST };
            let mut buf = [0u8; 8];
            let mut n = 0usize;
            // SAFETY: encoding into our own buffer.
            unsafe { g::ghostty_focus_encode(event, buf.as_mut_ptr(), buf.len(), &mut n) };
            buf[..n.min(buf.len())].to_vec()
        });
        // A report to the program, not typing.
        if let (Some(report), Some(shared)) = (report.filter(|r| !r.is_empty()), self.state().shared()) {
            shared.send(report);
        }
        self.setNeedsDisplay(true);
    }

    fn focus(&self) {
        if let Some(window) = self.window() {
            window.makeFirstResponder(Some(self));
        }
    }

    // --------------------------------------------------------------- keys

    fn key(&self, event: &NSEvent) {
        self.log_input(|| {
            let chars = event.characters().map(|s| s.to_string()).unwrap_or_default();
            let raw = event.charactersIgnoringModifiers().map(|s| s.to_string()).unwrap_or_default();
            let marked = self.state().ime.marked.clone();
            format!("key code {:#04x} chars {chars:?} raw {raw:?} mods {:#x} repeat {} marked {marked:?}", event.keyCode(), event.modifierFlags().0, event.isARepeat())
        });
        let flags = event.modifierFlags();
        if flags.contains(NSEventModifierFlags::Command) {
            let _: () = unsafe { msg_send![super(self), keyDown: event] };
            return;
        }
        let had_marked = self.state().ime.has_marked();
        // Ctrl combos go to the encoder (AppKit would make ⌃A a selector).
        if flags.contains(NSEventModifierFlags::Control) && !had_marked {
            let text = event.charactersIgnoringModifiers().map(|s| s.to_string());
            self.encode(event, text.as_deref());
            return;
        }
        self.state().typed = Some(Vec::new());
        self.interpretKeyEvents(&NSArray::from_slice(&[event]));
        let (typed, marked) = {
            let mut st = self.state();
            (st.typed.take().unwrap_or_default(), st.ime.has_marked())
        };
        if typed.is_empty() {
            // Enter, arrows, Backspace, Esc (not while the IME has them).
            if !had_marked && !marked {
                self.encode(event, None);
            }
            return;
        }
        self.send_typed(event, typed, had_marked);
    }

    /// What `interpretKeyEvents` inserted: a composition or several
    /// characters go as text, one character through the encoder (it knows
    /// the key's modes).
    fn send_typed(&self, event: &NSEvent, typed: Vec<String>, composed: bool) {
        for text in typed {
            if composed || text.chars().count() > 1 {
                self.send_text(&text);
            } else {
                self.encode(event, Some(&text));
            }
        }
    }

    fn encode(&self, event: &NSEvent, text: Option<&str>) {
        let key = Key { text, ..Key::of(event) };
        let bytes = self.with_core(|st, core| unsafe {
            scroll_to_bottom(core);
            encode_key(&st.io, core, keys::key(key.code), &key)
        });
        self.send(bytes.unwrap_or_default());
    }

    fn cursor_screen_rect(&self) -> NSRect {
        let st = self.state();
        let frame = self.frame(&st.fonts);
        let rect = match st.grid.cursor {
            Some(c) => frame.cell(c.x as usize, c.y, 1),
            None => frame.cell(0, 0, 1),
        };
        drop(st);
        let in_window = self.convertRect_toView(rect, None);
        self.window().map_or(in_window, |w| w.convertRectToScreen(in_window))
    }

    // -------------------------------------------------------------- mouse

    fn pointer(&self, event: &NSEvent) -> Pointer {
        let p = self.convertPoint_fromView(event.locationInWindow(), None);
        let st = self.state();
        let scale = st.fonts.scale;
        let height = self.bounds().size.height;
        let rows = st.grid.rows.len().max(1);
        let cols = st.grid.rows.first().map_or(1, Vec::len).max(1);
        let cell = |v: f64, size: f64, n: usize| ((v / size).floor().max(0.0) as usize).min(n - 1) as u16;
        Pointer {
            x: p.x * scale,
            y: (height - p.y) * scale,
            col: cell(p.x - PAD_X, st.fonts.cell_w, cols),
            row: cell(height - PAD_Y - p.y, st.fonts.cell_h, rows),
            mods: keys::mods(event.modifierFlags()),
            time_ns: (event.timestamp() * 1e9) as u64,
        }
    }

    /// The event for the program, when it tracks the mouse (Shift selects).
    fn report(&self, p: &Pointer, action: g::GhosttyMouseAction, button: Option<g::GhosttyMouseButton>, held: bool) -> Option<Vec<u8>> {
        if p.mods & g::GHOSTTY_MODS_SHIFT as g::GhosttyMods != 0 {
            return None;
        }
        let size = self.bounds().size;
        self.with_core(|st, core| {
            if !get::<bool>(core, g::GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING) {
                return None;
            }
            let (cw, ch) = st.fonts.cell_px();
            let scale = st.fonts.scale;
            let pad_x = (PAD_X * scale) as u32;
            let pad_y = (PAD_Y * scale) as u32;
            let geometry = g::GhosttyMouseEncoderSize {
                size: size_of::<g::GhosttyMouseEncoderSize>(),
                screen_width: (size.width * scale) as u32,
                screen_height: (size.height * scale) as u32,
                cell_width: cw,
                cell_height: ch,
                padding_top: pad_y,
                padding_bottom: pad_y,
                padding_right: pad_x,
                padding_left: pad_x,
            };
            let io = &st.io;
            let mut out = [0u8; 64];
            let mut n = 0usize;
            // SAFETY: our encoder and event, with the terminal locked.
            unsafe {
                g::ghostty_mouse_encoder_set_from_terminal(io.mouse_encoder, core.term);
                g::ghostty_mouse_encoder_set(io.mouse_encoder, g::GHOSTTY_MOUSE_ENCODER_OPT_SIZE, (&raw const geometry).cast());
                g::ghostty_mouse_encoder_set(io.mouse_encoder, g::GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, (&raw const held).cast());
                g::ghostty_mouse_event_set_action(io.mouse, action);
                match button {
                    Some(b) => g::ghostty_mouse_event_set_button(io.mouse, b),
                    None => g::ghostty_mouse_event_clear_button(io.mouse),
                };
                g::ghostty_mouse_event_set_mods(io.mouse, p.mods);
                g::ghostty_mouse_event_set_position(io.mouse, g::GhosttyMousePosition { x: p.x as f32, y: p.y as f32 });
                if g::ghostty_mouse_encoder_encode(io.mouse_encoder, io.mouse, out.as_mut_ptr(), out.len(), &mut n) != g::GHOSTTY_SUCCESS {
                    n = 0;
                }
            }
            Some(out[..n.min(out.len())].to_vec())
        })
        .flatten()
    }

    /// A selection gesture step; the terminal shows its result.
    fn gesture(&self, p: &Pointer, kind: g::GhosttySelectionGestureEventType) {
        let size = self.bounds().size;
        self.with_core(|st, core| {
            let Some(bound) = &st.bound else { return };
            let io = &st.io;
            let event = match kind {
                g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS => io.press,
                g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG => io.drag,
                _ => io.release,
            };
            let (cw, _) = st.fonts.cell_px();
            let geometry = g::GhosttySelectionGestureGeometry {
                columns: core.cols as u32,
                cell_width: cw,
                padding_left: (PAD_X * st.fonts.scale) as u32,
                screen_height: (size.height * st.fonts.scale) as u32,
            };
            let position = g::GhosttySurfacePosition { x: p.x, y: p.y };
            let point = g::GhosttyPoint {
                tag: g::GHOSTTY_POINT_TAG_VIEWPORT,
                value: g::GhosttyPointValue { coordinate: g::GhosttyPointCoordinate { x: p.col, y: p.row as u32 } },
            };
            // SAFETY: our gesture and events, with the terminal locked; the
            // values outlive the calls.
            unsafe {
                let mut cell: g::GhosttyGridRef = std::mem::zeroed();
                if g::ghostty_terminal_grid_ref(core.term, point, &mut cell) != g::GHOSTTY_SUCCESS {
                    return;
                }
                set_gesture_event(event, kind, &cell, &position, p.time_ns, &geometry);
                let mut selection: g::GhosttySelection = std::mem::zeroed();
                let made = g::ghostty_selection_gesture_event(bound.gesture, core.term, event, &mut selection) == g::GHOSTTY_SUCCESS;
                show_selection(core.term, made.then_some(&selection), kind);
            }
        });
        self.refresh();
    }

    fn press(&self, event: &NSEvent) {
        self.focus();
        let p = self.pointer(event);
        if p.mods & g::GHOSTTY_MODS_SUPER as g::GhosttyMods != 0 {
            self.open_link(&p);
            return;
        }
        let report = self.report(&p, g::GHOSTTY_MOUSE_ACTION_PRESS, Some(g::GHOSTTY_MOUSE_BUTTON_LEFT), true);
        self.state().reporting = report.is_some();
        match report {
            Some(bytes) => self.send(bytes),
            None => self.gesture(&p, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS),
        }
    }

    fn drag(&self, event: &NSEvent) {
        let p = self.pointer(event);
        if self.state().reporting {
            let bytes = self.report(&p, g::GHOSTTY_MOUSE_ACTION_MOTION, Some(g::GHOSTTY_MOUSE_BUTTON_LEFT), true);
            self.send(bytes.unwrap_or_default());
        } else {
            self.gesture(&p, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG);
        }
    }

    fn release(&self, event: &NSEvent) {
        let p = self.pointer(event);
        if std::mem::take(&mut self.state().reporting) {
            let bytes = self.report(&p, g::GHOSTTY_MOUSE_ACTION_RELEASE, Some(g::GHOSTTY_MOUSE_BUTTON_LEFT), false);
            self.send(bytes.unwrap_or_default());
        } else {
            self.gesture(&p, g::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE);
        }
    }

    /// ⌘-click: an OSC 8 link, else the word under the pointer (TSX decides
    /// whether it is a URL or a path).
    fn open_link(&self, p: &Pointer) {
        let text = self
            .with_core(|st, core| {
                let point = g::GhosttyPoint {
                    tag: g::GHOSTTY_POINT_TAG_VIEWPORT,
                    value: g::GhosttyPointValue { coordinate: g::GhosttyPointCoordinate { x: p.col, y: p.row as u32 } },
                };
                // SAFETY: reads of the locked terminal into our buffers.
                let uri = unsafe {
                    let mut cell: g::GhosttyGridRef = std::mem::zeroed();
                    let mut n = 0usize;
                    if g::ghostty_terminal_grid_ref(core.term, point, &mut cell) == g::GHOSTTY_SUCCESS
                        && g::ghostty_grid_ref_hyperlink_uri(&cell, ptr::null_mut(), 0, &mut n) == g::GHOSTTY_OUT_OF_SPACE
                    {
                        let mut buf = vec![0u8; n];
                        g::ghostty_grid_ref_hyperlink_uri(&cell, buf.as_mut_ptr(), buf.len(), &mut n);
                        String::from_utf8(buf).ok()
                    } else {
                        None
                    }
                };
                uri.or_else(|| st.grid.rows.get(p.row as usize).and_then(|row| grid::word_at(row, p.col as usize)))
            })
            .flatten();
        let st = self.state();
        if let (Some(text), Some(cx)) = (text, &st.cx) {
            log::line(|| format!("link {text:?}"));
            cx.emit("link", serde_json::json!({ "text": text }));
        }
    }

    fn scroll(&self, event: &NSEvent) {
        let dy = event.scrollingDeltaY();
        let lines = {
            let mut st = self.state();
            if event.hasPreciseScrollingDeltas() {
                st.scroll += dy / st.fonts.cell_h;
                let whole = st.scroll.trunc();
                st.scroll -= whole;
                whole as isize
            } else if dy != 0.0 {
                (dy.abs().round().max(1.0) * dy.signum()) as isize
            } else {
                0
            }
        };
        if lines == 0 {
            return;
        }
        // Up (towards older lines) is positive.
        let p = self.pointer(event);
        let wheel = if lines > 0 { g::GHOSTTY_MOUSE_BUTTON_FOUR } else { g::GHOSTTY_MOUSE_BUTTON_FIVE };
        if let Some(bytes) = self.report(&p, g::GHOSTTY_MOUSE_ACTION_PRESS, Some(wheel), false) {
            self.send(bytes.repeat(lines.unsigned_abs()));
            return;
        }
        let bytes = self.with_core(|st, core| {
            let alternate = get::<u32>(core, g::GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN) == g::GHOSTTY_TERMINAL_SCREEN_ALTERNATE;
            if alternate && core.dec_mode(1007) {
                // Alternate scroll: the program (less, vim) gets arrow keys.
                let key = Key { code: 0, mods: 0, repeat: false, text: None, unshifted: 0 };
                let arrow = if lines > 0 { g::GHOSTTY_KEY_ARROW_UP } else { g::GHOSTTY_KEY_ARROW_DOWN };
                // SAFETY: the terminal is locked.
                return unsafe { encode_key(&st.io, core, arrow, &key) }.repeat(lines.unsigned_abs());
            }
            let behavior = g::GhosttyTerminalScrollViewport {
                tag: g::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA,
                value: g::GhosttyTerminalScrollViewportValue { delta: -lines },
            };
            // SAFETY: the terminal is locked.
            unsafe { g::ghostty_terminal_scroll_viewport(core.term, behavior) };
            Vec::new()
        });
        self.send(bytes.unwrap_or_default());
        self.refresh();
    }

    // ---------------------------------------------------------- clipboard

    fn copy_selection(&self) {
        let text = self.with_core(|_, core| {
            // SAFETY: the selection is read and used under the same lock.
            let mut selection: g::GhosttySelection = unsafe { std::mem::zeroed() };
            let ok = unsafe { g::ghostty_terminal_get(core.term, g::GHOSTTY_TERMINAL_DATA_SELECTION, (&raw mut selection).cast()) };
            (ok == g::GHOSTTY_SUCCESS).then(|| core.text(Some(&selection)))
        });
        if let Some(text) = text.flatten().filter(|t| !t.is_empty()) {
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            // SAFETY: AppKit's pasteboard type constant.
            board.setString_forType(&NSString::from_str(&text), unsafe { NSPasteboardTypeString });
        }
    }

    fn paste_clipboard(&self) {
        // SAFETY: AppKit's pasteboard type constant.
        let Some(text) = NSPasteboard::generalPasteboard().stringForType(unsafe { NSPasteboardTypeString }) else { return };
        let mut data = text.to_string().into_bytes();
        let bytes = self.with_core(|_, core| {
            unsafe { scroll_to_bottom(core) };
            let bracketed = core.dec_mode(2004);
            let mut n = 0usize;
            // SAFETY: our buffers; the first call asks for the size.
            unsafe {
                g::ghostty_paste_encode(data.as_mut_ptr().cast(), data.len(), bracketed, ptr::null_mut(), 0, &mut n);
                let mut out = vec![0u8; n];
                let ok = g::ghostty_paste_encode(data.as_mut_ptr().cast(), data.len(), bracketed, out.as_mut_ptr(), out.len(), &mut n);
                if ok == g::GHOSTTY_SUCCESS { out.truncate(n) } else { out.clear() }
                out
            }
        });
        self.send(bytes.unwrap_or_default());
    }

    fn select_everything(&self) {
        self.with_core(|_, core| unsafe {
            let mut selection: g::GhosttySelection = std::mem::zeroed();
            if g::ghostty_terminal_select_all(core.term, &mut selection) == g::GHOSTTY_SUCCESS {
                g::ghostty_terminal_set(core.term, g::GHOSTTY_TERMINAL_OPT_SELECTION, (&raw const selection).cast());
            }
        });
        self.refresh();
    }
}

impl Drop for State {
    fn drop(&mut self) {
        if let Some(bound) = &self.bound {
            bound.shared.woken();
            let id = bound.shared.id;
            let _ = VIEWS.try_with(|v| v.borrow_mut().remove(&id));
        }
    }
}

/// `aed.terminal`: props `session` (a `TerminalSession` id), `fontFamily`,
/// `fontSize`, `theme` ({background, foreground, cursor, selection,
/// palette[16]}); events `focused` ({focused}), `link` ({text}); command
/// `focus`.
pub struct Terminal {
    view: Retained<TermView>,
}

impl Terminal {
    pub fn new(cx: ComponentContext) -> Terminal {
        let mtm = MainThreadMarker::new().expect("aed.terminal is made on the main thread");
        Terminal { view: TermView::new(mtm, cx) }
    }
}

impl NativeComponent for Terminal {
    fn view(&self) -> Retained<NSView> {
        Retained::into_super(self.view.clone())
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "session" => self.view.bind(value.and_then(JsonValue::as_u64).map(|id| id as u32)),
            "fontFamily" => {
                self.view.state().family = value.and_then(JsonValue::as_str).map(str::to_owned);
                self.view.set_font();
            }
            "fontSize" => {
                self.view.state().size = value.and_then(JsonValue::as_f64).filter(|s| *s > 0.0).unwrap_or(DEFAULT_FONT_SIZE);
                self.view.set_font();
            }
            "theme" => self.view.set_theme(value),
            _ => {}
        }
    }

    fn command(&mut self, name: &str, _args: &JsonValue) {
        if name == "focus" {
            self.view.focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ime_state_clears_marked_text_and_selected_range_on_reset() {
        let mut ime = ImeState::default();
        assert!(!ime.has_marked());
        assert_eq!(ime.marked_range(), NSRange::new(NSNotFound as usize, 0));
        assert_eq!(ime.selected_range(), NSRange::new(0, 0));

        ime.set_marked("你a𐐷".into(), NSRange::new(2, 2));
        assert!(ime.has_marked());
        // '你' (1) + 'a' (1) + '𐐷' (2 UTF-16 units) = 4 UTF-16 code units.
        assert_eq!(ime.marked_range(), NSRange::new(0, 4));
        assert_eq!(ime.selected_range(), NSRange::new(2, 2));

        assert!(ime.clear());
        assert!(!ime.has_marked());
        assert_eq!(ime.marked_range(), NSRange::new(NSNotFound as usize, 0));
        assert_eq!(ime.selected_range(), NSRange::new(0, 0));
        assert!(!ime.clear());

        ime.set_marked("zhong".into(), NSRange::new(5, 0));
        ime.set_marked(String::new(), NSRange::new(0, 0));
        assert!(!ime.has_marked());
    }

    #[test]
    fn display_sync_coalesces_burst_wakes_and_preserves_single_wake_clipping() {
        let mut sync = DisplaySync::default();
        // Idle cursor blink: single wake syncs dirty rows, `drawRect:` needs no second sync.
        assert_eq!(sync.on_wake(true), WakeAction::SyncDirty);
        sync.did_invalidate();
        assert!(!sync.on_draw());

        // Multi-chunk burst within one 60/120Hz frame: chunk 1 syncs, chunk 2 marks full once,
        // chunks 3..N hold `wake_pending`, and `drawRect:` runs one coalesced sync.
        assert_eq!(sync.on_wake(true), WakeAction::SyncDirty);
        sync.did_invalidate();
        assert_eq!(sync.on_wake(true), WakeAction::CoalesceFull);
        assert_eq!(sync.on_wake(true), WakeAction::Hold);
        assert_eq!(sync.on_wake(true), WakeAction::Hold);
        assert!(sync.on_draw());
        assert!(!sync.on_draw());

        // Hidden / unmounted view: first wake returns `CoalesceFull` so `needsDisplay` is armed
        // for when the view unhides, and subsequent wakes return `Hold`.
        assert_eq!(sync.on_wake(false), WakeAction::CoalesceFull);
        assert_eq!(sync.on_wake(false), WakeAction::Hold);
        assert!(sync.on_draw());
    }

    #[test]
    fn dirty_rows_coalesce_into_contiguous_spans_and_clip_outside_bounds() {
        assert_eq!(row_spans(vec![]), vec![]);
        assert_eq!(row_spans(vec![7]), vec![(7, 1)]);
        assert_eq!(row_spans(vec![5, 3, 4, 5, 9, 10, 12]), vec![(3, 3), (9, 2), (12, 1)]);

        // Frame height 44pt (`PAD_Y = 6`, `cell_h = 16`): rows 0 (`y = 22..38`) and 1 (`y = 6..22`) fit;
        // row 3 (`y = -26..-10`) lies completely below bounds (`y + h <= 0`) and is skipped.
        let frame = Frame { height: 44.0, cell_w: 8.0, cell_h: 16.0 };
        assert!(visible_row_rect(&frame, 200.0, 0, 2).is_some());
        assert_eq!(visible_row_rect(&frame, 200.0, 3, 1), None);
        assert_eq!(visible_row_rect(&frame, 0.0, 0, 1), None);
    }

    #[test]
    fn cursor_row_log_guard_requires_enabled_log_and_recent_typing() {
        let t0 = Instant::now();
        assert!(!should_log_cursor_row(false, Some(t0), t0));
        assert!(!should_log_cursor_row(true, None, t0));
        assert!(should_log_cursor_row(true, Some(t0), t0 + Duration::from_millis(1500)));
        assert!(!should_log_cursor_row(true, Some(t0), t0 + Duration::from_millis(1501)));
    }
}
