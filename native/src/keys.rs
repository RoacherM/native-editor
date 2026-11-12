//! macOS keys in libghostty's terms: physical keys (W3C codes) and modifiers.

use objc2_app_kit::NSEventModifierFlags;

use crate::ffi as g;

/// libghostty's modifier bits for AppKit's flags (Command is Super).
pub fn mods(flags: NSEventModifierFlags) -> g::GhosttyMods {
    let mut mods = 0;
    for (flag, bit) in [
        (NSEventModifierFlags::Shift, g::GHOSTTY_MODS_SHIFT),
        (NSEventModifierFlags::Control, g::GHOSTTY_MODS_CTRL),
        (NSEventModifierFlags::Option, g::GHOSTTY_MODS_ALT),
        (NSEventModifierFlags::Command, g::GHOSTTY_MODS_SUPER),
        (NSEventModifierFlags::CapsLock, g::GHOSTTY_MODS_CAPS_LOCK),
    ] {
        if flags.contains(flag) {
            mods |= bit as g::GhosttyMods;
        }
    }
    mods
}

/// The text a key event may carry to the encoder: none for control
/// characters and AppKit's function-key range (arrows, F-keys).
pub fn printable(text: &str) -> bool {
    text.chars().next().is_some_and(|c| !(c < ' ' || c == '\u{7f}' || ('\u{f700}'..='\u{f8ff}').contains(&c)))
}

/// macOS virtual key code (`kVK_*`) → libghostty physical key.
pub fn key(code: u16) -> g::GhosttyKey {
    use g::*;
    match code {
        0x00 => GHOSTTY_KEY_A, 0x01 => GHOSTTY_KEY_S, 0x02 => GHOSTTY_KEY_D, 0x03 => GHOSTTY_KEY_F,
        0x04 => GHOSTTY_KEY_H, 0x05 => GHOSTTY_KEY_G, 0x06 => GHOSTTY_KEY_Z, 0x07 => GHOSTTY_KEY_X,
        0x08 => GHOSTTY_KEY_C, 0x09 => GHOSTTY_KEY_V, 0x0B => GHOSTTY_KEY_B, 0x0C => GHOSTTY_KEY_Q,
        0x0D => GHOSTTY_KEY_W, 0x0E => GHOSTTY_KEY_E, 0x0F => GHOSTTY_KEY_R, 0x10 => GHOSTTY_KEY_Y,
        0x11 => GHOSTTY_KEY_T, 0x12 => GHOSTTY_KEY_DIGIT_1, 0x13 => GHOSTTY_KEY_DIGIT_2,
        0x14 => GHOSTTY_KEY_DIGIT_3, 0x15 => GHOSTTY_KEY_DIGIT_4, 0x16 => GHOSTTY_KEY_DIGIT_6,
        0x17 => GHOSTTY_KEY_DIGIT_5, 0x18 => GHOSTTY_KEY_EQUAL, 0x19 => GHOSTTY_KEY_DIGIT_9,
        0x1A => GHOSTTY_KEY_DIGIT_7, 0x1B => GHOSTTY_KEY_MINUS, 0x1C => GHOSTTY_KEY_DIGIT_8,
        0x1D => GHOSTTY_KEY_DIGIT_0, 0x1E => GHOSTTY_KEY_BRACKET_RIGHT, 0x1F => GHOSTTY_KEY_O,
        0x20 => GHOSTTY_KEY_U, 0x21 => GHOSTTY_KEY_BRACKET_LEFT, 0x22 => GHOSTTY_KEY_I,
        0x23 => GHOSTTY_KEY_P, 0x24 => GHOSTTY_KEY_ENTER, 0x25 => GHOSTTY_KEY_L, 0x26 => GHOSTTY_KEY_J,
        0x27 => GHOSTTY_KEY_QUOTE, 0x28 => GHOSTTY_KEY_K, 0x29 => GHOSTTY_KEY_SEMICOLON,
        0x2A => GHOSTTY_KEY_BACKSLASH, 0x2B => GHOSTTY_KEY_COMMA, 0x2C => GHOSTTY_KEY_SLASH,
        0x2D => GHOSTTY_KEY_N, 0x2E => GHOSTTY_KEY_M, 0x2F => GHOSTTY_KEY_PERIOD, 0x30 => GHOSTTY_KEY_TAB,
        0x31 => GHOSTTY_KEY_SPACE, 0x32 => GHOSTTY_KEY_BACKQUOTE, 0x33 => GHOSTTY_KEY_BACKSPACE,
        0x35 => GHOSTTY_KEY_ESCAPE, 0x4C => GHOSTTY_KEY_NUMPAD_ENTER, 0x73 => GHOSTTY_KEY_HOME,
        0x74 => GHOSTTY_KEY_PAGE_UP, 0x75 => GHOSTTY_KEY_DELETE, 0x77 => GHOSTTY_KEY_END,
        0x79 => GHOSTTY_KEY_PAGE_DOWN, 0x7B => GHOSTTY_KEY_ARROW_LEFT, 0x7C => GHOSTTY_KEY_ARROW_RIGHT,
        0x7D => GHOSTTY_KEY_ARROW_DOWN, 0x7E => GHOSTTY_KEY_ARROW_UP, 0x7A => GHOSTTY_KEY_F1,
        0x78 => GHOSTTY_KEY_F2, 0x63 => GHOSTTY_KEY_F3, 0x76 => GHOSTTY_KEY_F4, 0x60 => GHOSTTY_KEY_F5,
        0x61 => GHOSTTY_KEY_F6, 0x62 => GHOSTTY_KEY_F7, 0x64 => GHOSTTY_KEY_F8, 0x65 => GHOSTTY_KEY_F9,
        0x6D => GHOSTTY_KEY_F10, 0x67 => GHOSTTY_KEY_F11, 0x6F => GHOSTTY_KEY_F12,
        _ => GHOSTTY_KEY_UNIDENTIFIED,
    }
}

/// Columns `c` takes on the screen: 2 for East Asian wide and emoji, else 1
/// (for the IME's marked text, which is not in the terminal yet).
pub fn width(c: char) -> usize {
    let u = c as u32;
    let wide = matches!(u,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF | 0x20000..=0x3FFFD);
    if wide { 2 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printable_excludes_controls_and_function_keys() {
        assert!(printable("a"));
        assert!(printable("中"));
        assert!(!printable("\r"));
        assert!(!printable("\u{7f}"));
        assert!(!printable("\u{f700}")); // up arrow
        assert!(!printable(""));
    }

    #[test]
    fn widths_of_marked_text() {
        assert_eq!("ni你好".chars().map(width).sum::<usize>(), 6);
        assert_eq!(width('Ａ'), 2);
        assert_eq!(width('ｱ'), 1);
        assert_eq!(width('é'), 1);
    }
}
