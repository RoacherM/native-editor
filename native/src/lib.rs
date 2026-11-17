//! Aed's native crate: the terminal (`TerminalSession` + `aed.terminal`
//! view), runtime design-token bridge (`setTokens`), and off-thread TextMate
//! syntax highlighter (`highlightCode`).
//! DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」·「文件预览与 Mermaid 渲染契约」.

use std::collections::BTreeMap;

use nsh_core::prelude::*;

#[allow(non_camel_case_types, non_upper_case_globals, non_snake_case, dead_code, unsafe_op_in_unsafe_fn, clippy::all)]
mod ffi;
#[cfg(target_os = "macos")]
mod grid;
pub mod highlight;
#[cfg(target_os = "macos")]
mod keys;
mod log;
mod pty;
mod session;
#[cfg(target_os = "macos")]
mod view;

fn merged_tokens(base: &Tokens, colors: &BTreeMap<String, String>) -> Tokens {
    let mut next = base.clone();
    for (name, hex) in colors {
        if let Some(color) = nsh_core::Color::parse(hex) {
            next.set_color(name, AdaptiveColor::from(color));
        }
    }
    next
}

/// Runtime design-token bridge for TSX (`import { setTokens } from "aed/native"`).
#[module]
pub struct ThemeTokensBridge;

#[module(flat)]
impl ThemeTokensBridge {
    /// Updates the surface's design color tokens (`token()`, `tokens()`, and
    /// Tailwind token classes), keeping tokens not listed in `colors`.
    pub async fn set_tokens(colors: BTreeMap<String, String>) {
        let next = merged_tokens(&tokens(), &colors);
        nsh_core::prelude::set_tokens(next);
    }

    /// Highlights `text` up to `max_lines` with TextMate (`syntect` + `two-face`)
    /// on a blocking worker thread, returning flat `[line, start_col, end_col, role]`
    /// UTF-16 quads (`1..=10`).
    pub async fn highlight_code(text: String, language: String, max_lines: u32) -> Vec<u32> {
        nsh_core::prelude::blocking(move || highlight::parse(&text, &language, max_lines as usize))
            .await
            .unwrap_or_default()
    }
}

/// Aed's native exports: `TerminalSession`, `setTokens`, and `highlightCode`.
#[native_module("aed/native")]
fn native(registry: &mut Registry) {
    registry.class::<session::TerminalSession>();
    registry.module::<ThemeTokensBridge>();
}

/// The `aed.terminal` view; sessions wake it to redraw.
#[native_components(macos)]
fn components(components: &nsh_platform_macos::Components) {
    // Headless runs and tests write no log, and even in the packaged app the
    // debug log only activates when AED_TERMINAL_LOG is explicitly set.
    if log::env_enabled(std::env::var_os("AED_TERMINAL_LOG").as_deref()) {
        log::enable();
    }
    pty::use_user_config();
    session::on_change(view::wake);
    components.register("aed.terminal", std::rc::Rc::new(|cx| Box::new(view::Terminal::new(cx)) as Box<dyn nsh_platform_macos::NativeComponent>));
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, rc::Rc};

    use nsh_core::{
        ApproxTextEngine, Color, Core, Op, Size,
        element::{RustCall, RustOp},
        prelude::*,
    };

    use super::{ThemeTokensBridge, registry};

    #[test]
    fn set_tokens_updates_core_design_tokens_and_preserves_existing_entries() {
        let mut core = Core::new(Rc::new(ApproxTextEngine), Size::default());
        core.set_components(registry());

        let mut initial = Tokens::default();
        initial.set_number("radius", 8.0);
        initial.set_font("font-mono", "JetBrains Mono");
        initial.set_color("background", AdaptiveColor::from(Color::parse("#efebe3").unwrap()));
        core.set_tokens(initial);

        let mut patch = BTreeMap::new();
        patch.insert("background".to_owned(), "#161514".to_owned());
        patch.insert("primary".to_owned(), "#e8462b".to_owned());
        patch.insert("invalid".to_owned(), "not-a-color".to_owned());

        core.apply(Op::Rust(RustOp {
            call: 1,
            run: RustCall::Task(Box::new(move || {
                Box::pin(async move {
                    ThemeTokensBridge::set_tokens(patch).await;
                    Ok(Box::new(()) as Box<dyn nsh_core::element::ToJs>)
                })
            })),
        }))
        .expect("apply setTokens op");
        core.run_component_tasks();

        assert_eq!(core.tokens().color("background"), Some(AdaptiveColor::from(Color::parse("#161514").unwrap())));
        assert_eq!(core.tokens().color("primary"), Some(AdaptiveColor::from(Color::parse("#e8462b").unwrap())));
        assert_eq!(core.tokens().color("invalid"), None);
        assert_eq!(core.tokens().number("radius"), Some(8.0));
        assert_eq!(core.tokens().font("font-mono").map(|f| &**f), Some("JetBrains Mono"));
    }
}
