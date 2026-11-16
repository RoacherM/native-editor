//! What the view draws: a copy of libghostty's render state (cells,
//! colours, cursor), the font's metrics and system cascade glyph cache,
//! and the CoreText drawing.

use std::{collections::HashMap, ptr::NonNull};

use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSAttributedStringNSStringDrawing, NSColor, NSFont, NSFontAttributeName, NSFontDescriptorSymbolicTraits,
    NSFontManager, NSFontTraitMask, NSForegroundColorAttributeName,
};
use objc2_core_foundation::{CFRange, CFRetained, CFString, CGAffineTransform, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGContext;
use objc2_core_text::{CTFont, CTFontOrientation};
use objc2_foundation::{NSAttributedString, NSDictionary, NSString};

use crate::{ffi as g, keys};

/// Horizontal and vertical padding in points (`PAD_X = 12pt` aligns terminal
/// text with the 12pt tab & statusbar spine; `PAD_Y = 6pt` top and bottom).
pub const PAD_X: f64 = 12.0;
pub const PAD_Y: f64 = 6.0;

const BOLD: u16 = 1 << 0;
const FAINT: u16 = 1 << 2;
const INVERSE: u16 = 1 << 4;
const INVISIBLE: u16 = 1 << 5;

pub type Rgb = [u8; 3];

/// A colour with alpha, from `#rgb`, `#rrggbb` or `#rrggbbaa`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rgba(pub [u8; 4]);

impl Rgba {
    pub fn parse(hex: &str) -> Option<Rgba> {
        let h = hex.strip_prefix('#').filter(|h| h.is_ascii())?;
        let full: String = match h.len() {
            3 => h.chars().flat_map(|c| [c, c]).chain("ff".chars()).collect(),
            6 => format!("{h}ff"),
            8 => h.to_owned(),
            _ => return None,
        };
        let bytes: Vec<u8> = (0..4).map(|i| u8::from_str_radix(&full[2 * i..2 * i + 2], 16).ok()).collect::<Option<_>>()?;
        Some(Rgba([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn rgb(self) -> Rgb {
        [self.0[0], self.0[1], self.0[2]]
    }
}

#[derive(Clone, Default)]
pub struct Cell {
    pub text: String,
    fg: Option<Rgb>,
    bg: Option<Rgb>,
    flags: u16,
    selected: bool,
}

impl Cell {
    fn clear(&mut self) {
        self.text.clear();
        self.fg = None;
        self.bg = None;
        self.flags = 0;
        self.selected = false;
    }
}

#[derive(Clone, Copy, PartialEq)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    style: g::GhosttyCursorStyle,
}

/// The screen as last read from the render state.
#[derive(Default)]
pub struct Grid {
    pub rows: Vec<Vec<Cell>>,
    pub bg: Rgb,
    fg: Rgb,
    cursor_color: Option<Rgb>,
    pub cursor: Option<Cursor>,
}

impl Grid {
    /// Resizes rows and columns in place so surviving `Cell`s retain their
    /// `String` capacities across split-drag resizes.
    pub fn resize(&mut self, rows: usize, cols: usize) -> bool {
        let resized = self.rows.len() != rows || self.rows.iter().any(|r| r.len() != cols);
        if resized {
            self.rows.resize_with(rows, Vec::new);
            for row in &mut self.rows {
                row.resize_with(cols, Cell::default);
            }
        }
        resized
    }
}

/// Which rows a sync changed.
pub enum Changed {
    None,
    Rows(Vec<u16>),
    All,
}

/// libghostty's render state handles, for one view.
pub struct Render {
    state: g::GhosttyRenderState,
    rows: g::GhosttyRenderStateRowIterator,
    cells: g::GhosttyRenderStateRowCells,
}

impl Render {
    pub fn new() -> Render {
        let mut r = Render { state: std::ptr::null_mut(), rows: std::ptr::null_mut(), cells: std::ptr::null_mut() };
        // SAFETY: creation of our own handles.
        unsafe {
            g::ghostty_render_state_new(std::ptr::null(), &mut r.state);
            g::ghostty_render_state_row_iterator_new(std::ptr::null(), &mut r.rows);
            g::ghostty_render_state_row_cells_new(std::ptr::null(), &mut r.cells);
        }
        r
    }

    /// Copies what changed in `term` (held under its lock) into `grid`.
    ///
    /// # Safety
    /// `term` must be a live terminal no other thread uses during the call.
    pub unsafe fn sync(&mut self, term: g::GhosttyTerminal, grid: &mut Grid) -> Changed {
        unsafe {
            if g::ghostty_render_state_update(self.state, term) != g::GHOSTTY_SUCCESS {
                return Changed::None;
            }
            let mut dirty: g::GhosttyRenderStateDirty = 0;
            g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_DIRTY, (&raw mut dirty).cast());
            let (mut cols, mut rows) = (0u16, 0u16);
            g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_COLS, (&raw mut cols).cast());
            g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_ROWS, (&raw mut rows).cast());
            let resized = grid.resize(rows as usize, cols as usize);
            if dirty == g::GHOSTTY_RENDER_STATE_DIRTY_FALSE && !resized {
                return Changed::None;
            }
            let recoloured = self.read_colors(grid);
            let full = resized || recoloured || dirty == g::GHOSTTY_RENDER_STATE_DIRTY_FULL;
            let mut changed = self.read_cursor(grid);
            changed.extend(self.read_rows(grid, full));
            g::ghostty_render_state_clean(self.state);
            if full { Changed::All } else { Changed::Rows(changed) }
        }
    }

    /// The default colours into `grid`; whether they changed (every cell
    /// may use them).
    unsafe fn read_colors(&self, grid: &mut Grid) -> bool {
        let mut colors = g::GhosttyRenderStateColors { size: size_of::<g::GhosttyRenderStateColors>(), ..Default::default() };
        unsafe { g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_COLORS, (&raw mut colors).cast()) };
        let rgb = |c: g::GhosttyColorRgb| [c.r, c.g, c.b];
        let new = (rgb(colors.background), rgb(colors.foreground), colors.cursor_has_value.then_some(rgb(colors.cursor)));
        let changed = new != (grid.bg, grid.fg, grid.cursor_color);
        (grid.bg, grid.fg, grid.cursor_color) = new;
        changed
    }

    /// The cursor into `grid`; the rows it left and entered.
    unsafe fn read_cursor(&self, grid: &mut Grid) -> Vec<u16> {
        let mut c = g::GhosttyRenderStateCursor { size: size_of::<g::GhosttyRenderStateCursor>(), ..Default::default() };
        unsafe { g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_CURSOR, (&raw mut c).cast()) };
        let old = grid.cursor;
        grid.cursor = (c.visible && c.viewport_has_value).then_some(Cursor { x: c.viewport_x, y: c.viewport_y, style: c.visual_style });
        [old, grid.cursor].into_iter().flatten().map(|c| c.y).collect()
    }

    /// Every row (`all`) or the dirty ones into `grid`; the rows read.
    unsafe fn read_rows(&mut self, grid: &mut Grid, all: bool) -> Vec<u16> {
        let mut read = Vec::new();
        unsafe {
            g::ghostty_render_state_get(self.state, g::GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, (&raw mut self.rows).cast());
            let mut index = 0u16;
            loop {
                let mut y = index;
                let more = if all {
                    g::ghostty_render_state_row_iterator_next(self.rows)
                } else {
                    g::ghostty_render_state_row_iterator_next_dirty(self.rows, &mut y)
                };
                if !more {
                    break;
                }
                index += 1;
                self.read_row(&mut grid.rows, y);
                read.push(y);
            }
        }
        read
    }

    unsafe fn read_row(&mut self, rows: &mut [Vec<Cell>], y: u16) {
        let Some(row) = rows.get_mut(y as usize) else { return };
        unsafe {
            g::ghostty_render_state_row_get(self.rows, g::GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, (&raw mut self.cells).cast());
            let mut x = 0usize;
            let mut buf = [0u8; 64];
            while g::ghostty_render_state_row_cells_next(self.cells) {
                let Some(cell) = row.get_mut(x) else { break };
                x += 1;
                let get = |data, out: *mut libc::c_void| g::ghostty_render_state_row_cells_get(self.cells, data, out);
                let mut text = g::GhosttyBuffer { ptr: buf.as_mut_ptr(), cap: buf.len(), len: 0 };
                get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, (&raw mut text).cast());
                cell.text.clear();
                if text.len > 0 && text.len <= buf.len() {
                    cell.text.push_str(&String::from_utf8_lossy(&buf[..text.len]));
                }
                let mut rgb = g::GhosttyColorRgb::default();
                cell.fg = (get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, (&raw mut rgb).cast()) == g::GHOSTTY_SUCCESS).then_some([rgb.r, rgb.g, rgb.b]);
                cell.bg = (get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, (&raw mut rgb).cast()) == g::GHOSTTY_SUCCESS).then_some([rgb.r, rgb.g, rgb.b]);
                let mut styled = false;
                get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_HAS_STYLING, (&raw mut styled).cast());
                cell.flags = 0;
                if styled {
                    let mut style = g::GhosttyStyle::default();
                    get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, (&raw mut style).cast());
                    cell.flags = style.flags;
                }
                cell.selected = false;
                get(g::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, (&raw mut cell.selected).cast());
            }
            for cell in row.iter_mut().skip(x) {
                cell.clear();
            }
        }
    }
}

impl Drop for Render {
    fn drop(&mut self) {
        // SAFETY: our handles, freed once.
        unsafe {
            g::ghostty_render_state_row_cells_free(self.cells);
            g::ghostty_render_state_row_iterator_free(self.rows);
            g::ghostty_render_state_free(self.state);
        }
    }
}

/// The terminal font: regular, bold, system cascade fonts, cell size, and
/// `(char, bold) -> Option<(font_idx, CGGlyph)>` cache (`0` = regular,
/// `1` = bold, `2 + i` = `cascade[i]`).
pub struct Fonts {
    regular: Retained<NSFont>,
    bold: Retained<NSFont>,
    cascade: Vec<CFRetained<CTFont>>,
    /// A cell, in points; a whole number of device pixels.
    pub cell_w: f64,
    pub cell_h: f64,
    pub scale: f64,
    descent: f64,
    glyphs: HashMap<(char, bool), Option<(u16, u16)>>,
}

fn ct_font(font: &NSFont) -> &CTFont {
    // SAFETY: NSFont and CTFont are toll-free bridged.
    unsafe { &*(font as *const NSFont as *const CTFont) }
}

/// A font by full or PostScript name, else by family.
fn named_font(family: &str, size: f64) -> Option<Retained<NSFont>> {
    let name = NSString::from_str(family);
    NSFont::fontWithName_size(&name, size).or_else(|| {
        let manager = NSFontManager::sharedFontManager(MainThreadMarker::new()?);
        manager.fontWithFamily_traits_weight_size(&name, NSFontTraitMask(0), 5, size)
    })
}

impl Fonts {
    pub fn new(family: Option<&str>, size: f64, scale: f64) -> Fonts {
        let regular = family
            .filter(|f| !f.is_empty())
            .and_then(|f| named_font(f, size))
            .unwrap_or_else(|| unsafe { NSFont::monospacedSystemFontOfSize_weight(size, objc2_app_kit::NSFontWeightRegular) });
        let bold_desc = regular.fontDescriptor().fontDescriptorWithSymbolicTraits(NSFontDescriptorSymbolicTraits::TraitBold);
        let bold = NSFont::fontWithDescriptor_size(&bold_desc, size).unwrap_or_else(|| regular.clone());
        let (ascent, descent, leading) = (regular.ascender(), -regular.descender(), regular.leading());
        let mut ch = 'M' as u16;
        let mut glyph = 0u16;
        let mut advance = CGSize::new(0.0, 0.0);
        // SAFETY: one character, one glyph, one advance.
        unsafe {
            let ct = ct_font(&regular);
            ct.glyphs_for_characters(NonNull::from(&mut ch), NonNull::from(&mut glyph), 1);
            ct.advances_for_glyphs(CTFontOrientation::Horizontal, NonNull::from(&mut glyph), &mut advance, 1);
        }
        let pixels = |points: f64| (points * scale).round().max(1.0) / scale;
        Fonts {
            regular,
            bold,
            cascade: Vec::new(),
            cell_w: pixels(advance.width),
            cell_h: pixels((ascent + descent + leading).ceil()),
            scale,
            descent: descent + leading / 2.0,
            glyphs: HashMap::new(),
        }
    }

    /// The cell in device pixels (libghostty's sizes).
    pub fn cell_px(&self) -> (u32, u32) {
        ((self.cell_w * self.scale).round() as u32, (self.cell_h * self.scale).round() as u32)
    }

    fn font(&self, bold: bool) -> &NSFont {
        if bold { &self.bold } else { &self.regular }
    }

    fn ct_at(&self, idx: u16) -> &CTFont {
        match idx {
            0 => ct_font(&self.regular),
            1 => ct_font(&self.bold),
            i => &self.cascade[(i - 2) as usize],
        }
    }

    /// Cached `(font_idx, CGGlyph)` for BMP and non-BMP (`> U+FFFF`) characters,
    /// resolving system cascade fonts once via `CTFontCreateForString` when the
    /// primary monospace font lacks `c`.
    fn glyph(&mut self, c: char, bold: bool) -> Option<(u16, u16)> {
        if let Some(&cached) = self.glyphs.get(&(c, bold)) {
            return cached;
        }
        let mut units = [0u16; 2];
        let len = c.encode_utf16(&mut units).len();
        let mut out = [0u16; 2];
        let base_idx = u16::from(bold);
        let base = self.ct_at(base_idx);
        // SAFETY: `units` and `out` both hold `len` (1 or 2) UTF-16 slots.
        unsafe { base.glyphs_for_characters(NonNull::from(&mut units[0]), NonNull::from(&mut out[0]), len as isize) };
        if out[0] != 0 {
            let hit = Some((base_idx, out[0]));
            self.glyphs.insert((c, bold), hit);
            return hit;
        }
        let mut utf8 = [0u8; 4];
        let cf_str = CFString::from_str(c.encode_utf8(&mut utf8));
        // SAFETY: CoreText selects the cascade font covering the UTF-16 range.
        let sub = unsafe { base.for_string(&cf_str, CFRange { location: 0, length: len as isize }) };
        out = [0u16; 2];
        unsafe { sub.glyphs_for_characters(NonNull::from(&mut units[0]), NonNull::from(&mut out[0]), len as isize) };
        let resolved = if out[0] != 0 {
            let idx = match self.cascade.iter().position(|f| **f == *sub) {
                Some(i) => (i + 2) as u16,
                None => {
                    let idx = (self.cascade.len() + 2) as u16;
                    self.cascade.push(sub);
                    idx
                }
            };
            Some((idx, out[0]))
        } else {
            None
        };
        self.glyphs.insert((c, bold), resolved);
        resolved
    }
}

/// The view's geometry: rows count down from the top of a non-flipped view.
pub struct Frame {
    pub height: f64,
    pub cell_w: f64,
    pub cell_h: f64,
}

impl Frame {
    pub fn row_top(&self, y: u16) -> f64 {
        self.height - PAD_Y - (y as f64 + 1.0) * self.cell_h
    }

    /// Whether row `y` reaches into `rect`.
    fn row_meets(&self, y: u16, rect: CGRect) -> bool {
        let top = self.row_top(y);
        top + self.cell_h >= rect.origin.y && top <= rect.origin.y + rect.size.height
    }

    pub fn x(&self, col: usize) -> f64 {
        PAD_X + col as f64 * self.cell_w
    }

    pub fn cell(&self, col: usize, y: u16, cols: usize) -> CGRect {
        CGRect::new(CGPoint::new(self.x(col), self.row_top(y)), CGSize::new(cols as f64 * self.cell_w, self.cell_h))
    }
}

/// What a draw needs besides the grid.
pub struct Look {
    pub focused: bool,
    pub selection: Option<Rgba>,
    /// The IME's marked text, drawn at the cursor.
    pub marked: Option<String>,
}

fn set_fill(ctx: &CGContext, rgb: Rgb, alpha: CGFloat) {
    CGContext::set_rgb_fill_color(Some(ctx), rgb[0] as f64 / 255.0, rgb[1] as f64 / 255.0, rgb[2] as f64 / 255.0, alpha);
}

pub fn fill(ctx: &CGContext, rgb: Rgb, rect: CGRect) {
    set_fill(ctx, rgb, 1.0);
    CGContext::fill_rect(Some(ctx), rect);
}

impl Grid {
    fn colors(&self, cell: &Cell) -> (Rgb, Option<Rgb>) {
        let mut fg = cell.fg.unwrap_or(self.fg);
        let mut bg = cell.bg;
        if cell.flags & INVERSE != 0 {
            (fg, bg) = (bg.unwrap_or(self.bg), Some(fg));
        }
        if cell.flags & FAINT != 0 {
            for (c, b) in fg.iter_mut().zip(self.bg) {
                *c = ((*c as u16 + b as u16) / 2) as u8;
            }
        }
        (fg, bg)
    }

    fn cursor_rgb(&self) -> Rgb {
        self.cursor_color.unwrap_or(self.fg)
    }

    /// Draws the rows that meet `dirty`.
    pub fn draw(&self, ctx: &CGContext, fonts: &mut Fonts, frame: &Frame, dirty: CGRect, look: &Look) {
        fill(ctx, self.bg, dirty);
        let block = |c: &Cursor| look.focused && c.style == g::GHOSTTY_CURSOR_STYLE_BLOCK && look.marked.is_none();
        for (y, row) in self.rows.iter().enumerate() {
            let y = y as u16;
            if !frame.row_meets(y, dirty) {
                continue;
            }
            let block_x = self.cursor.filter(|c| c.y == y && block(c)).map(|c| c.x as usize);
            self.draw_backgrounds(ctx, frame, row, y, block_x);
            if let Some(sel) = look.selection {
                draw_selection(ctx, frame, row, y, sel);
            }
            self.draw_glyphs(ctx, fonts, frame, row, y, block_x);
        }
        if let Some(c) = self.cursor.filter(|c| !block(c)) {
            self.draw_cursor(ctx, frame, c, look);
        }
        if let (Some(text), Some(c)) = (&look.marked, self.cursor) {
            self.draw_marked(ctx, fonts, frame, c, text);
        }
    }

    /// A row's backgrounds, in runs of one colour (no seams between cells);
    /// the block cursor's cell is in the cursor colour.
    fn draw_backgrounds(&self, ctx: &CGContext, frame: &Frame, row: &[Cell], y: u16, block_x: Option<usize>) {
        let mut run: Option<(usize, Rgb)> = None;
        for x in 0..=row.len() {
            let bg = row.get(x).and_then(|cell| if block_x == Some(x) { Some(self.cursor_rgb()) } else { self.colors(cell).1 });
            if run.map(|r| r.1) != bg {
                if let Some((start, rgb)) = run {
                    fill(ctx, rgb, frame.cell(start, y, x - start));
                }
                run = bg.map(|rgb| (x, rgb));
            }
        }
    }

    /// A row's text, in runs of `(font_idx, fg)`; under the block cursor in
    /// the cell's background colour.
    fn draw_glyphs(&self, ctx: &CGContext, fonts: &mut Fonts, frame: &Frame, row: &[Cell], y: u16, block_x: Option<usize>) {
        let baseline = frame.row_top(y) + fonts.descent;
        let (mut glyphs, mut points): (Vec<u16>, Vec<CGPoint>) = (Vec::new(), Vec::new());
        let mut style: Option<(u16, Rgb)> = None;
        for (x, cell) in row.iter().enumerate() {
            if cell.text.is_empty() || cell.text == " " || cell.flags & INVISIBLE != 0 {
                continue;
            }
            let (fg, bg) = self.colors(cell);
            let fg = if block_x == Some(x) { bg.unwrap_or(self.bg) } else { fg };
            let bold = cell.flags & BOLD != 0;
            match single_char(&cell.text).and_then(|c| fonts.glyph(c, bold)) {
                Some((font_idx, glyph)) => {
                    if style != Some((font_idx, fg)) {
                        flush(ctx, fonts, style, &mut glyphs, &mut points);
                        style = Some((font_idx, fg));
                    }
                    glyphs.push(glyph);
                    points.push(CGPoint::new(frame.x(x), baseline));
                }
                None => {
                    flush(ctx, fonts, style, &mut glyphs, &mut points);
                    fallback(fonts.font(bold), &cell.text, fg, frame.x(x), baseline);
                }
            }
        }
        flush(ctx, fonts, style, &mut glyphs, &mut points);
    }

    /// A bar, underline or hollow block (also the block while unfocused).
    fn draw_cursor(&self, ctx: &CGContext, frame: &Frame, c: Cursor, look: &Look) {
        let cell = frame.cell(c.x as usize, c.y, 1);
        set_fill(ctx, self.cursor_rgb(), 1.0);
        let thin = 2.0f64.min(cell.size.width);
        let line = |x: f64, y: f64, w: f64, h: f64| CGContext::fill_rect(Some(ctx), CGRect::new(CGPoint::new(x, y), CGSize::new(w, h)));
        let (o, s) = (cell.origin, cell.size);
        match c.style {
            g::GHOSTTY_CURSOR_STYLE_BAR if look.focused => line(o.x, o.y, thin, s.height),
            g::GHOSTTY_CURSOR_STYLE_UNDERLINE if look.focused => line(o.x, o.y, s.width, thin),
            _ => {
                line(o.x, o.y, s.width, 1.0);
                line(o.x, o.y + s.height - 1.0, s.width, 1.0);
                line(o.x, o.y, 1.0, s.height);
                line(o.x + s.width - 1.0, o.y, 1.0, s.height);
            }
        }
    }

    /// The IME's composition at the cursor: on the background, underlined.
    fn draw_marked(&self, ctx: &CGContext, fonts: &Fonts, frame: &Frame, c: Cursor, text: &str) {
        let cols = text.chars().map(keys::width).sum::<usize>().max(1);
        let rect = frame.cell(c.x as usize, c.y, cols);
        fill(ctx, self.bg, rect);
        fallback(fonts.font(false), text, self.fg, rect.origin.x, rect.origin.y + fonts.descent);
        set_fill(ctx, self.fg, 1.0);
        CGContext::fill_rect(Some(ctx), CGRect::new(rect.origin, CGSize::new(rect.size.width, 1.0)));
    }
}

/// A row's selected cells, under the selection colour (with its alpha).
fn draw_selection(ctx: &CGContext, frame: &Frame, row: &[Cell], y: u16, sel: Rgba) {
    set_fill(ctx, sel.rgb(), sel.0[3] as f64 / 255.0);
    for x in row.iter().enumerate().filter(|(_, c)| c.selected).map(|(x, _)| x) {
        CGContext::fill_rect(Some(ctx), frame.cell(x, y, 1));
    }
}

/// The character of a one-character cell (not a multi-codepoint cluster).
fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Some(c),
        _ => None,
    }
}

fn flush(ctx: &CGContext, fonts: &Fonts, style: Option<(u16, Rgb)>, glyphs: &mut Vec<u16>, points: &mut Vec<CGPoint>) {
    let Some((font_idx, fg)) = style else { return };
    if glyphs.is_empty() {
        return;
    }
    set_fill(ctx, fg, 1.0);
    // CTFontDrawGlyphs applies the text matrix, which is not part of the
    // graphics state: text drawn before (AppKit's, our cluster fallback)
    // leaves it moved, and the row would land that far right.
    CGContext::set_text_matrix(Some(ctx), CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: 0.0, ty: 0.0 });
    // SAFETY: as many positions as glyphs.
    unsafe {
        fonts.ct_at(font_idx).draw_glyphs(
            NonNull::new_unchecked(glyphs.as_mut_ptr()),
            NonNull::new_unchecked(points.as_mut_ptr()),
            glyphs.len(),
            ctx,
        );
    }
    glyphs.clear();
    points.clear();
}

/// Multi-codepoint grapheme clusters: AppKit shapes and picks a fallback font.
fn fallback(font: &NSFont, text: &str, fg: Rgb, x: f64, baseline: f64) {
    let color = NSColor::colorWithSRGBRed_green_blue_alpha(fg[0] as f64 / 255.0, fg[1] as f64 / 255.0, fg[2] as f64 / 255.0, 1.0);
    // SAFETY: AppKit's attribute name constants.
    let keys = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
    let values: [&AnyObject; 2] = [font.as_ref(), color.as_ref()];
    let attrs = NSDictionary::from_slices(&keys, &values);
    // SAFETY: font and colour values for their attribute names.
    let s = unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(text), &attrs) };
    s.drawAtPoint(CGPoint::new(x, baseline + font.descender()));
}

/// The whitespace-delimited word at `col` (a ⌘-click), without the
/// brackets, quotes and punctuation around it.
pub fn word_at(row: &[Cell], col: usize) -> Option<String> {
    let solid = |c: &Cell| !c.text.is_empty() && !c.text.chars().all(char::is_whitespace);
    if !row.get(col).is_some_and(solid) {
        return None;
    }
    let start = row[..col].iter().rposition(|c| !solid(c)).map_or(0, |i| i + 1);
    let end = row[col..].iter().position(|c| !solid(c)).map_or(row.len(), |i| col + i);
    let word: String = row[start..end].iter().map(|c| c.text.as_str()).collect();
    let word = word.trim_start_matches(['(', '[', '{', '<', '"', '\'', '`']);
    let word = word.trim_end_matches([')', ']', '}', '>', '"', '\'', '`', ',', ';', '.', ':', '!', '?']);
    (!word.is_empty()).then(|| word.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{Cell, Fonts, Frame, Grid, Look, PAD_X, PAD_Y, Rgba, word_at};
    use objc2_core_foundation::{CGAffineTransform, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGContext, CGImageAlphaInfo};

    fn row(text: &str) -> Vec<Cell> {
        text.chars().map(|c| Cell { text: if c == ' ' { String::new() } else { c.to_string() }, ..Default::default() }).collect()
    }

    #[test]
    fn the_word_under_a_click_loses_its_punctuation() {
        let r = row("see (src/main.rs:12:3), or https://x.dev/a?b=1.");
        assert_eq!(word_at(&r, 8).as_deref(), Some("src/main.rs:12:3"));
        assert_eq!(word_at(&r, 30).as_deref(), Some("https://x.dev/a?b=1"));
        assert_eq!(word_at(&r, 3), None);
        assert_eq!(word_at(&r, 0).as_deref(), Some("see"));
    }

    #[test]
    fn colours_parse_with_and_without_alpha() {
        assert_eq!(Rgba::parse("#161514"), Some(Rgba([0x16, 0x15, 0x14, 255])));
        assert_eq!(Rgba::parse("#e8462b33"), Some(Rgba([0xe8, 0x46, 0x2b, 0x33])));
        assert_eq!(Rgba::parse("#fff"), Some(Rgba([255, 255, 255, 255])));
        assert_eq!(Rgba::parse("#a1c"), Some(Rgba([0xaa, 0x11, 0xcc, 255])));
        assert_eq!(Rgba::parse("#ééé"), None);
        assert_eq!(Rgba::parse("e8462b"), None);
        assert_eq!(Rgba::parse("#12345"), None);
        assert_eq!(Rgba::parse("#zzzzzz"), None);
    }

    fn render_cells(cells: Vec<Cell>, left_over: f64) -> (Vec<u8>, usize, usize, Frame, Fonts) {
        let (w, h) = (220usize, 44usize);
        let space = CGColorSpace::new_device_rgb().unwrap();
        // SAFETY: a context of our own size that owns its pixels.
        let ctx = unsafe { CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, w * 4, Some(&space), CGImageAlphaInfo::PremultipliedLast.0) }.unwrap();
        CGContext::set_text_matrix(Some(&ctx), CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: left_over, ty: 0.0 });
        let mut fonts = Fonts::new(None, 14.0, 1.0);
        let frame = Frame { height: h as f64, cell_w: fonts.cell_w, cell_h: fonts.cell_h };
        let mut grid = Grid { bg: [0, 0, 0], fg: [255, 255, 255], ..Default::default() };
        grid.rows = vec![cells];
        let look = Look { focused: false, selection: None, marked: None };
        grid.draw(&ctx, &mut fonts, &frame, CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)), &look);
        // SAFETY: the context's own w × h RGBA pixels.
        let px = unsafe { std::slice::from_raw_parts(CGBitmapContextGetData(Some(&ctx)) as *const u8, w * h * 4) }.to_vec();
        (px, w, h, frame, fonts)
    }

    /// The leftmost column with ink, drawing "zsh" at column 0 into a
    /// context whose text matrix earlier text drawing left at `left_over`.
    fn first_ink(left_over: f64) -> usize {
        let (px, w, h, _, _) = render_cells(row("zsh"), left_over);
        (0..w).find(|&x| (0..h).any(|y| px[(y * w + x) * 4] > 128)).unwrap()
    }

    #[test]
    fn spine_padding_places_first_column_at_12pt_and_keeps_6pt_vertical() {
        assert_eq!(PAD_X, 12.0);
        assert_eq!(PAD_Y, 6.0);
        let frame = Frame { height: 100.0, cell_w: 8.0, cell_h: 16.0 };
        assert_eq!(frame.x(0), 12.0);
        assert_eq!(frame.x(2), 28.0);
        assert_eq!(frame.row_top(0), 100.0 - 6.0 - 16.0);
    }

    #[test]
    fn text_starts_in_its_cell_whatever_drew_text_before() {
        let clean = first_ink(0.0);
        assert!((12..20).contains(&clean), "expected 12pt horizontal spine padding, got ink at {clean}");
        assert_eq!(first_ink(30.0), clean);
    }

    #[test]
    fn cjk_and_non_bmp_glyphs_cache_cascade_fonts_and_render_ink() {
        // Wide CJK occupies 2 cells per glyph; non-BMP U+1D400 ('𝐀') has UTF-16 len 2.
        let cells = vec![
            Cell { text: "中".into(), ..Default::default() },
            Cell::default(),
            Cell { text: "文".into(), ..Default::default() },
            Cell::default(),
            Cell { text: "𝐀".into(), ..Default::default() },
        ];
        let (px, w, h, frame, fonts) = render_cells(cells, 0.0);
        let c1 = fonts.glyphs.get(&('中', false)).copied().flatten().expect("cached CJK glyph 1");
        let c2 = fonts.glyphs.get(&('文', false)).copied().flatten().expect("cached CJK glyph 2");
        let non_bmp = fonts.glyphs.get(&('𝐀', false)).copied().flatten().expect("cached > U+FFFF surrogate glyph");
        // Both CJK codepoints share one deduplicated cascade CTFont entry.
        assert_eq!(c1.0, c2.0);
        assert!(c1.0 >= 2);
        assert!(fonts.cascade.len() <= 2, "cascade fonts must deduplicate: got {}", fonts.cascade.len());
        assert_ne!(non_bmp.1, 0);

        let has_ink_in_span = |col_start: usize, col_span: usize| {
            let x0 = frame.x(col_start).floor() as usize;
            let x1 = (frame.x(col_start + col_span).ceil() as usize).min(w);
            (x0..x1).any(|x| (0..h).any(|y| px[(y * w + x) * 4] > 64))
        };
        assert!(has_ink_in_span(0, 2), "expected CJK ink in columns 0..2");
        assert!(has_ink_in_span(2, 2), "expected CJK ink in columns 2..4");
        assert!(has_ink_in_span(4, 2), "expected non-BMP > U+FFFF ink at column 4");
    }

    #[test]
    fn resizing_grid_in_place_preserves_cell_string_capacity() {
        let mut grid = Grid::default();
        assert!(grid.resize(2, 4));
        grid.rows[0][0].text.reserve(64);
        let cap = grid.rows[0][0].text.capacity();
        assert!(cap >= 64);

        assert!(grid.resize(5, 8));
        assert_eq!(grid.rows.len(), 5);
        assert_eq!(grid.rows[0].len(), 8);
        assert!(grid.rows[0][0].text.capacity() >= cap);

        assert!(!grid.resize(5, 8));
        assert!(grid.resize(3, 6));
        assert!(grid.rows[0][0].text.capacity() >= cap);
    }
}
