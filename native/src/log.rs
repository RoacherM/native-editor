//! The terminal's debug log, for checking what reached the shell and the
//! screen: `~/Library/Caches/dev.byronwayne.aed/terminal.log` (0600, in the
//! 0700 cache dir), moved to `terminal.log.1` past 2 MB. On only in the app
//! (`enable` from the view registration), never in tests. Keys are hidden
//! while a program reads a password (canonical input, no echo). DESIGN.md「持久化标识与
//! IPC 契约」.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_BYTES: u64 = 2 << 20;

static ON: AtomicBool = AtomicBool::new(false);
static FILE: Mutex<Option<File>> = Mutex::new(None);

/// Starts logging (the app; headless runs and tests never call it).
pub fn enable() {
    ON.store(true, Ordering::Relaxed);
}

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let dir = PathBuf::from(home).join("Library/Caches/dev.byronwayne.aed");
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).ok()?;
    Some(dir.join("terminal.log"))
}

fn open(path: &PathBuf) -> Option<File> {
    OpenOptions::new().create(true).append(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path).ok()
}

/// Appends one line (with the local time); `line` runs only when on.
pub fn line(line: impl FnOnce() -> String) {
    if !on() {
        return;
    }
    let text = format!("{} {}\n", now(), line());
    let mut file = FILE.lock().unwrap();
    let Some(path) = path() else { return };
    if file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
        *file = None;
    }
    if file.is_none() {
        *file = open(&path);
    }
    if let Some(f) = file.as_mut() {
        let _ = f.write_all(text.as_bytes());
    }
}

fn now() -> String {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as libc::time_t;
    // SAFETY: localtime_r into our own struct.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{:02}:{:02}:{:02}.{:03}", tm.tm_hour, tm.tm_min, tm.tm_sec, since.subsec_millis())
}

/// Bytes as readable text: UTF-8 as is, controls escaped (`\r`, `\e`, `\x07`).
pub fn escape(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.utf8_chunks() {
        chunk.valid().chars().for_each(|c| push_char(&mut out, c));
        for b in chunk.invalid() {
            out.push_str(&format!("\\x{b:02x}"));
        }
    }
    out
}

fn push_char(out: &mut String, c: char) {
    match c {
        '\r' => out.push_str("\\r"),
        '\n' => out.push_str("\\n"),
        '\t' => out.push_str("\\t"),
        '\x1b' => out.push_str("\\e"),
        '\\' => out.push_str("\\\\"),
        c if (c as u32) < 0x20 || c == '\x7f' => out.push_str(&format!("\\x{:02x}", c as u32)),
        c => out.push(c),
    }
}

#[cfg(test)]
mod tests {
    use super::escape;

    #[test]
    fn escaped_bytes_keep_text_and_show_controls() {
        assert_eq!(escape(b"echo\r"), "echo\\r");
        assert_eq!(escape("接口".as_bytes()), "接口");
        assert_eq!(escape(b"\x1b[A\x7f\\"), "\\e[A\\x7f\\\\");
        assert_eq!(escape(&[0xe6, 0x8e]), "\\xe6\\x8e");
    }
}
