use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

use super::*;

fn sh(session: &TerminalSession) {
    let options = ShellOptions {
        shell: "/bin/sh".into(),
        cwd: "/tmp".into(),
        term_program: "Aed".into(),
        resources_dir: String::new(),
    };
    session.start(options).expect("start /bin/sh");
}

fn type_line(session: &TerminalSession, line: &str) {
    session.write(format!("{line}\r").into_bytes());
}

/// Waits (5 s at most) until the screen has a line `pred` accepts.
fn wait_line(session: &TerminalSession, pred: impl Fn(&str) -> bool) -> String {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let text = session.screen_text();
        if let Some(line) = text.lines().find(|l| pred(l)) {
            return line.to_owned();
        }
        assert!(Instant::now() < until, "no such line on screen:\n{text}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The next event that is not `output`, within 5 s.
fn next_event(session: &TerminalSession) -> SessionEvent {
    let (tx, rx) = mpsc::channel();
    let shared = session.shared.clone();
    std::thread::spawn(move || loop {
        let event = shared.wait_event();
        if event.kind != "output" {
            let _ = tx.send(event);
            return;
        }
    });
    rx.recv_timeout(Duration::from_secs(5)).expect("an event")
}

#[test]
fn a_shell_runs_commands_and_its_output_reaches_the_screen() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    assert!(session.running());
    type_line(&session, "echo HELLO_$((6*7))");
    wait_line(&session, |l| l == "HELLO_42");
}

#[test]
fn a_resize_reaches_the_shell_as_its_terminal_size() {
    let session = TerminalSession::new(32, 140);
    sh(&session);
    type_line(&session, "stty size; echo SIZE_ONE");
    wait_line(&session, |l| l == "32 140");
    session.resize(40, 120);
    type_line(&session, "stty size; echo SIZE_TWO");
    wait_line(&session, |l| l == "40 120");
}

#[test]
fn the_exit_event_carries_the_shell_code_and_the_screen_stays() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    type_line(&session, "echo BEFORE_EXIT; exit 3");
    let event = next_event(&session);
    assert_eq!((event.kind.as_str(), event.code), ("exit", Some(3)));
    assert!(!session.running());
    // A new shell writes on the same screen.
    sh(&session);
    type_line(&session, "echo AFTER_EXIT");
    wait_line(&session, |l| l == "AFTER_EXIT");
    assert!(session.screen_text().contains("BEFORE_EXIT"));
}

#[test]
fn a_stopped_shell_ends_without_an_exit_event() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    type_line(&session, "echo UP");
    wait_line(&session, |l| l == "UP");
    session.stop();
    assert!(!session.running());
    session.feed("\x1b]2;after stop\x07".into());
    let event = next_event(&session);
    assert_eq!(event.kind, "title", "no exit before the title: {event:?}");
}

#[test]
fn osc_titles_come_through_cleaned() {
    let session = TerminalSession::new(24, 80);
    session.feed("\x1b]2;  vim main.rs \x07".into());
    let event = next_event(&session);
    assert_eq!((event.kind.as_str(), event.title.as_deref()), ("title", Some("vim main.rs")));
}

#[test]
fn clear_keeps_only_the_cursor_row() {
    let session = TerminalSession::new(10, 40);
    let lines: String = (0..30).map(|i| format!("line {i}\r\n")).collect();
    session.feed(format!("{lines}prompt$ "));
    assert!(session.screen_text().contains("line 0"));
    session.clear();
    assert_eq!(session.screen_text().trim(), "prompt$");
    // The cursor stays after the prompt.
    session.feed("typed".into());
    assert_eq!(session.screen_text().trim(), "prompt$ typed");
}

#[test]
fn soft_wrapped_lines_come_out_whole() {
    let session = TerminalSession::new(10, 20);
    let long = "中".repeat(30);
    session.feed(format!("{long}\r\n"));
    assert!(session.screen_text().lines().any(|l| l == long));
}

#[test]
fn utf8_split_across_writes_arrives_whole() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    let bytes = "echo 中文字符_OK\r".as_bytes().to_vec();
    let cut = bytes.iter().position(|&b| b == 0xe4).unwrap() + 1;
    session.write(bytes[..cut].to_vec());
    session.write(bytes[cut..].to_vec());
    wait_line(&session, |l| l == "中文字符_OK");
    assert!(!session.screen_text().contains('\u{fffd}'));
}

#[test]
fn close_ends_next_event() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    let shared = session.shared.clone();
    let id = session.id();
    assert!(find(id).is_some());
    session.close();
    assert_eq!(shared.wait_event().kind, "closed");
    assert!(find(id).is_none());
}

#[test]
fn typing_marks_the_shell_used_and_keys_without_a_shell_ask_for_one() {
    let session = TerminalSession::new(24, 80);
    session.write(b"x".to_vec());
    assert_eq!(next_event(&session).kind, "input");
    sh(&session);
    assert!(!session.used());
    type_line(&session, "echo TYPED");
    assert!(session.used());
    wait_line(&session, |l| l == "TYPED");
    // A new shell is not used yet.
    sh(&session);
    assert!(!session.used());
}

#[test]
fn the_shell_gets_default_signals_and_a_utf8_tty() {
    // The app (a Rust binary) ignores SIGPIPE; the shell's programs must not.
    let session = TerminalSession::new(24, 80);
    sh(&session);
    type_line(&session, "yes | head -1; stty -a | grep -o -- '-*iutf8'; echo SIGNALS_DONE");
    wait_line(&session, |l| l == "SIGNALS_DONE");
    let text = session.screen_text();
    assert!(!text.contains("Broken pipe"), "SIGPIPE was ignored:\n{text}");
    assert!(text.lines().any(|l| l == "iutf8"), "IUTF8 is off:\n{text}");
}

#[test]
fn a_shell_that_exits_ends_even_while_a_job_holds_the_terminal() {
    let session = TerminalSession::new(24, 80);
    sh(&session);
    // The background job keeps the PTY open well past the 5 s wait.
    type_line(&session, "nohup sleep 20 >/dev/null 2>&1 & exit 4");
    let event = next_event(&session);
    assert_eq!((event.kind.as_str(), event.code), ("exit", Some(4)));
    assert!(!session.running());
}

#[test]
fn a_shell_that_cannot_start_says_why() {
    let session = TerminalSession::new(24, 80);
    let options = |shell: &str, cwd: &str| ShellOptions {
        shell: shell.into(),
        cwd: cwd.into(),
        term_program: "Aed".into(),
        resources_dir: String::new(),
    };
    assert!(session.start(options("/nonexistent/shell", "/tmp")).is_err());
    assert!(session.start(options("/bin/sh", "/nonexistent/dir")).is_err());
    assert!(!session.running());
}
