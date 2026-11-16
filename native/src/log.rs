//! The terminal's debug log, for checking what reached the shell and the
//! screen: `~/Library/Caches/dev.byronwayne.aed/terminal.log` (0600, in the
//! 0700 cache dir), moved to `terminal.log.1` past 2 MB. On only when
//! `AED_TERMINAL_LOG` is set and non-empty in the app (`enable` from the view
//! registration), never in tests. Keys are hidden while a program reads a
//! password (canonical input, no echo). DESIGN.md「持久化标识与 IPC 契约」.

use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_BYTES: u64 = 2 << 20;

static ON: AtomicBool = AtomicBool::new(false);
static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static WRITER: Mutex<Option<(BufWriter<File>, u64)>> = Mutex::new(None);

/// Whether `AED_TERMINAL_LOG` enables terminal logging (set and non-empty).
pub fn env_enabled(value: Option<&OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// Starts logging (the app when `AED_TERMINAL_LOG` is set; headless runs and tests never call it).
pub fn enable() {
    ON.store(true, Ordering::Relaxed);
}

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

fn resolve_path(home: Option<&OsStr>) -> Option<PathBuf> {
    let home = home.filter(|h| Path::new(h).is_absolute())?;
    Some(Path::new(home).join("Library/Caches/dev.byronwayne.aed/terminal.log"))
}

fn path() -> Option<&'static Path> {
    PATH.get_or_init(|| resolve_path(std::env::var_os("HOME").as_deref())).as_deref()
}

fn open(path: &Path) -> Option<(BufWriter<File>, u64)> {
    let dir = path.parent()?;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).ok()?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let size = file.metadata().map_or(0, |m| m.len());
    Some((BufWriter::new(file), size))
}

fn append(slot: &mut Option<(BufWriter<File>, u64)>, path: &Path, bytes: &[u8], max_bytes: u64) {
    if slot.is_none() {
        *slot = open(path);
    }
    if slot.as_ref().is_some_and(|(_, written)| *written > max_bytes) {
        *slot = None;
        let _ = fs::rename(path, path.with_extension("log.1"));
        *slot = open(path);
    }
    if let Some((writer, written)) = slot.as_mut() {
        if writer.write_all(bytes).is_ok() && writer.flush().is_ok() {
            *written += bytes.len() as u64;
        } else {
            *slot = None;
        }
    }
}

/// Appends one line (with the local time); `line` runs only when on.
pub fn line(line: impl FnOnce() -> String) {
    if !on() {
        return;
    }
    let Some(path) = path() else { return };
    let text = format!("{} {}\n", now(), line());
    let mut slot = WRITER.lock().unwrap();
    append(&mut slot, path, text.as_bytes(), MAX_BYTES);
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
    use std::{
        ffi::OsStr,
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
    };

    use super::{append, env_enabled, escape, resolve_path};

    #[test]
    fn escaped_bytes_keep_text_and_show_controls() {
        assert_eq!(escape(b"echo\r"), "echo\\r");
        assert_eq!(escape("接口".as_bytes()), "接口");
        assert_eq!(escape(b"\x1b[A\x7f\\"), "\\e[A\\x7f\\\\");
        assert_eq!(escape(&[0xe6, 0x8e]), "\\xe6\\x8e");
    }

    #[test]
    fn log_enables_only_when_env_var_is_non_empty() {
        assert!(!env_enabled(None));
        assert!(!env_enabled(Some(OsStr::new(""))));
        assert!(env_enabled(Some(OsStr::new("1"))));
        assert!(env_enabled(Some(OsStr::new("true"))));
    }

    #[test]
    fn log_path_requires_an_absolute_home() {
        assert_eq!(resolve_path(None), None);
        assert_eq!(resolve_path(Some(OsStr::new(""))), None);
        assert_eq!(resolve_path(Some(OsStr::new("relative/home"))), None);
        assert_eq!(
            resolve_path(Some(OsStr::new("/Users/alice"))),
            Some(PathBuf::from("/Users/alice/Library/Caches/dev.byronwayne.aed/terminal.log"))
        );
    }

    #[test]
    fn writer_tracks_bytes_in_memory_and_rotates_past_limit() {
        let root = std::env::temp_dir().join(format!(
            "aed-log-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let log_path = root.join("Caches/dev.byronwayne.aed/terminal.log");
        let mut slot = None;

        append(&mut slot, &log_path, b"first line\n", 20);
        assert_eq!(slot.as_ref().map(|(_, n)| *n), Some(11));
        let dir_mode = fs::metadata(log_path.parent().unwrap()).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(&log_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);

        append(&mut slot, &log_path, b"second line!\n", 20);
        assert_eq!(slot.as_ref().map(|(_, n)| *n), Some(24));
        assert!(!log_path.with_extension("log.1").exists());

        // Past max_bytes (24 > 20): next write rotates to terminal.log.1 and resets the counter.
        append(&mut slot, &log_path, b"fresh\n", 20);
        assert_eq!(slot.as_ref().map(|(_, n)| *n), Some(6));
        assert_eq!(fs::read_to_string(log_path.with_extension("log.1")).unwrap(), "first line\nsecond line!\n");
        assert_eq!(fs::read_to_string(&log_path).unwrap(), "fresh\n");

        drop(slot);
        let _ = fs::remove_dir_all(&root);
    }
}
