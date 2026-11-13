//! Aed's native crate: the terminal. A `TerminalSession` class per tab (a
//! libghostty-vt terminal and the shell on its PTY) and the `aed.terminal`
//! view that draws one and takes its keys. DESIGN.md「内置 PTY 终端与
//! Ghostty 配置探测」.

use nsh_core::prelude::*;

#[allow(non_camel_case_types, non_upper_case_globals, non_snake_case, dead_code, unsafe_op_in_unsafe_fn, clippy::all)]
mod ffi;
#[cfg(target_os = "macos")]
mod grid;
#[cfg(target_os = "macos")]
mod keys;
mod log;
mod pty;
mod session;
#[cfg(target_os = "macos")]
mod view;

/// Aed's native exports: `TerminalSession`.
#[native_module("aed/native")]
fn native(registry: &mut Registry) {
    registry.class::<session::TerminalSession>();
}

/// The `aed.terminal` view; sessions wake it to redraw.
#[native_components(macos)]
fn components(components: &nsh_platform_macos::Components) {
    // Only the app registers views: headless runs and tests write no log,
    // and their shells leave the user's startup files and history alone.
    log::enable();
    pty::use_user_config();
    session::on_change(view::wake);
    components.register("aed.terminal", std::rc::Rc::new(|cx| Box::new(view::Terminal::new(cx)) as Box<dyn nsh_platform_macos::NativeComponent>));
}
