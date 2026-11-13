//! A login shell on a pseudo-terminal: fork, size, read, write, reap.
//! DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」.

use std::{
    ffi::CString,
    io,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};

static USER_CONFIG: AtomicBool = AtomicBool::new(false);

/// The app's shells read the user's startup files and keep the user's
/// history. Until this is called (`nsh test`, `cargo test`) a shell gets a
/// private, empty `ZDOTDIR` and `HISTFILE` instead (`private_config`), so
/// tests never write the user's history.
pub fn use_user_config() {
    USER_CONFIG.store(true, Ordering::Relaxed);
}

/// `$TMPDIR/aed-shell-<pid>` (0700): zsh reads no startup files from it and
/// keeps its history there (`/etc/zshrc` puts `HISTFILE` in `ZDOTDIR`).
fn private_config() -> Option<PathBuf> {
    if USER_CONFIG.load(Ordering::Relaxed) {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("aed-shell-{}", std::process::id()));
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).ok()?;
    Some(dir)
}

/// What a shell starts with.
pub struct ShellSpec<'a> {
    /// The shell's executable (`/bin/zsh`).
    pub shell: &'a str,
    /// Its working directory.
    pub cwd: &'a str,
    /// `TERM_PROGRAM` for the shell ("Aed", or the detected terminal app's).
    pub term_program: &'a str,
    /// `GHOSTTY_RESOURCES_DIR`, when Ghostty is installed ("" for none).
    pub resources_dir: &'a str,
    pub rows: u16,
    pub cols: u16,
}

/// A running shell: the PTY master and the child's pid.
#[derive(Clone, Copy)]
pub struct Child {
    pub fd: i32,
    pub pid: libc::pid_t,
}

/// The shell's environment: the app's, with the terminal's own variables.
fn environment(spec: &ShellSpec) -> Vec<CString> {
    const OURS: [&str; 6] =
        ["TERM", "COLORTERM", "TERM_PROGRAM", "DISABLE_AUTO_TITLE", "PROMPT_EOL_MARK", "GHOSTTY_RESOURCES_DIR"];
    let private = private_config();
    let replaced = |k: &str| OURS.contains(&k) || (private.is_some() && (k == "ZDOTDIR" || k == "HISTFILE"));
    let mut vars: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !replaced(k)).collect();
    if let Some(dir) = private {
        vars.push(("ZDOTDIR".into(), dir.to_string_lossy().into_owned()));
        vars.push(("HISTFILE".into(), dir.join(".history").to_string_lossy().into_owned()));
    }
    vars.push(("TERM".into(), "xterm-256color".into()));
    vars.push(("COLORTERM".into(), "truecolor".into()));
    vars.push(("TERM_PROGRAM".into(), spec.term_program.into()));
    vars.push(("DISABLE_AUTO_TITLE".into(), "true".into()));
    vars.push(("PROMPT_EOL_MARK".into(), String::new()));
    if !spec.resources_dir.is_empty() {
        vars.push(("GHOSTTY_RESOURCES_DIR".into(), spec.resources_dir.into()));
    }
    vars.into_iter().filter_map(|(k, v)| CString::new(format!("{k}={v}")).ok()).collect()
}

/// Forks `spec.shell -l` in `spec.cwd` on a new PTY of the given size. A
/// shell that cannot start (no such directory or executable) is an error,
/// not a shell that exits 127.
pub fn spawn(spec: &ShellSpec) -> io::Result<Child> {
    let invalid = |_| io::Error::from(io::ErrorKind::InvalidInput);
    let path = CString::new(spec.shell).map_err(invalid)?;
    let dash_l = c"-l";
    let argv = [path.as_ptr(), dash_l.as_ptr(), ptr::null()];
    let dir = CString::new(spec.cwd).map_err(invalid)?;
    // Built before the fork: the child only calls async-signal-safe functions.
    let env = environment(spec);
    let mut envp: Vec<*const libc::c_char> = env.iter().map(|s| s.as_ptr()).collect();
    envp.push(ptr::null());
    let mut ws = libc::winsize { ws_row: spec.rows.max(1), ws_col: spec.cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
    // The child's errno if chdir or exec fails; closed by a successful exec.
    let mut report = [-1; 2];
    // SAFETY: a pipe of our own, close-on-exec on both ends.
    unsafe {
        if libc::pipe(report.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }
        for end in report {
            libc::fcntl(end, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    let mut fd = -1;
    // SAFETY: forkpty with a valid winsize; the child sets up and execs, or exits.
    let pid = unsafe { libc::forkpty(&mut fd, ptr::null_mut(), ptr::null_mut(), &mut ws) };
    if pid == 0 {
        // SAFETY: the forked child; pointers stay valid until exec.
        unsafe { exec_shell(&dir, &path, &argv, &envp, report[1]) }
    }
    close(report[1]);
    if pid < 0 {
        close(report[0]);
        return Err(io::Error::last_os_error());
    }
    // SAFETY: our new fd; a later child (the next shell) must not inherit it.
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    let mut errno = [0u8; 4];
    let got = read(report[0], &mut errno);
    close(report[0]);
    if got == Some(errno.len()) {
        close(fd);
        wait(pid);
        return Err(io::Error::from_raw_os_error(i32::from_ne_bytes(errno)));
    }
    Ok(Child { fd, pid })
}

/// The child's side of `spawn`: default signals (the app ignores SIGPIPE,
/// and an ignored signal is inherited by every program the shell runs), a
/// UTF-8 line discipline (Backspace erases a whole character), then the
/// shell; on failure its errno goes to `report`.
///
/// # Safety
/// Only in the child forked by `spawn`; async-signal-safe calls only.
unsafe fn exec_shell(
    dir: &CString,
    path: &CString,
    argv: &[*const libc::c_char; 3],
    envp: &[*const libc::c_char],
    report: i32,
) -> ! {
    unsafe {
        let mut none: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut none);
        libc::sigprocmask(libc::SIG_SETMASK, &none, ptr::null_mut());
        for signal in 1..32 { // macOS NSIG; SIGKILL and SIGSTOP just fail
            libc::signal(signal, libc::SIG_DFL);
        }
        let mut tty: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut tty) == 0 {
            tty.c_iflag |= libc::IUTF8;
            libc::tcsetattr(0, libc::TCSANOW, &tty);
        }
        if libc::chdir(dir.as_ptr()) == 0 {
            libc::execve(path.as_ptr(), argv.as_ptr(), envp.as_ptr());
        }
        let errno = *libc::__error();
        libc::write(report, (&raw const errno).cast(), size_of::<i32>());
        libc::_exit(127);
    }
}

/// Whether a program reads a password: canonical input without echo (how
/// `getpass` and `sudo` read). Line editors (zsh, readline) also turn echo
/// off, but read raw, so a prompt is not one.
pub fn reads_password(fd: i32) -> bool {
    // SAFETY: tcgetattr into our own struct; the master reports the slave's modes.
    let mut tty: libc::termios = unsafe { std::mem::zeroed() };
    let got = unsafe { libc::tcgetattr(fd, &mut tty) } == 0;
    got && tty.c_lflag & libc::ECHO == 0 && tty.c_lflag & libc::ICANON != 0
}

/// The kernel's terminal size for the PTY; the shell gets SIGWINCH.
pub fn set_size(fd: i32, rows: u16, cols: u16) {
    let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCSWINSZ with a valid winsize on our fd.
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) };
}

/// Reads what the shell wrote; `None` at its end (EOF, or EIO once the
/// last process holding the terminal exited).
pub fn read(fd: i32, buf: &mut [u8]) -> Option<usize> {
    loop {
        // SAFETY: reading into our own buffer.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 {
            return Some(n as usize);
        }
        if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return None;
    }
}

/// Writes all of `bytes` (blocking); stops when the PTY is gone.
pub fn write_all(fd: i32, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        // SAFETY: writing our own bytes.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n > 0 {
            bytes = &bytes[n as usize..];
        } else if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        } else {
            return;
        }
    }
}

/// A second fd for the same PTY, owned by the writer thread.
pub fn dup(fd: i32) -> i32 {
    // SAFETY: F_DUPFD_CLOEXEC on our fd.
    unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) }
}

pub fn close(fd: i32) {
    // SAFETY: an fd this module opened, closed once by its owner.
    unsafe { libc::close(fd) };
}

/// Hangs up the shell (SIGHUP, as a closing terminal does).
pub fn hang_up(pid: libc::pid_t) {
    // SAFETY: a signal to our own child.
    unsafe { libc::kill(pid, libc::SIGHUP) };
}

/// Waits for the shell to end: its exit code, 128+n for signal n.
pub fn wait(pid: libc::pid_t) -> i32 {
    let mut status = 0;
    loop {
        // SAFETY: reaping our own child.
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r == pid {
            break;
        }
        if r < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return -1;
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}
