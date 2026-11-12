import type { EditorTheme } from "./themes";

// DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」. The terminal's colours per
// app theme, for the native `aed.terminal` view (src/TerminalPane.tsx).

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const ANSI_NAMES: readonly (keyof AnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function palette(colors: string): AnsiPalette {
  const list = colors.trim().split(/\s+/);
  return Object.fromEntries(ANSI_NAMES.map((name, i) => [name, list[i]])) as unknown as AnsiPalette;
}

/**
 * The 16 ANSI colours per theme, in ANSI order. The upstream palettes of
 * each theme, except where a colour is too faint on the theme's background
 * (bright black is zsh's autosuggestion colour; light themes keep `white`
 * readable as text).
 */
export const ANSI_PALETTES: Readonly<Record<string, AnsiPalette>> = {
  "industrial-paper": palette(`
    #141414 #c62d14 #4d6b1f #8a5a00 #2f4b63 #8e3b6b #2b6b6b #6d685f
    #57534b #b0260f #5e7d2a #9c4a07 #3d6a8f #a8467f #357f7f #7a7468`),
  "industrial-carbon": palette(`
    #2a2826 #f06a4f #b5c28f #e0a96d #9fb4c7 #d199b5 #8fc1b5 #d9d3c7
    #8f897e #ff8466 #cbd8a3 #f0c08a #b9cde0 #e3b3cb #a9d6cb #f7f4ee`),
  "kanagawa-dragon": palette(`
    #0d0c0c #c4746e #8a9a7b #c4b28a #8ba4b0 #a292a3 #8ea4a2 #c8c093
    #a6a69c #e46876 #87a987 #e6c384 #7fb4ca #938aa9 #7aa89f #c5c9c5`),
  "tokyo-night": palette(`
    #15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6
    #737aa2 #ff899d #9fe044 #faba4a #8db0ff #c7a9ff #a4daff #c0caf5`),
  "catppuccin-mocha": palette(`
    #45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de
    #7f849c #f37799 #89d88b #ebd391 #74a8fc #f2aede #6bd7ca #a6adc8`),
  "one-dark": palette(`
    #282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf
    #7f848e #e88389 #a9d18b #f0cf8f #7cbdf5 #d48fe8 #6fc7d2 #ffffff`),
  "rose-pine": palette(`
    #26233a #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4
    #6e6a86 #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4`),
  "github-light": palette(`
    #24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781
    #57606a #a40e26 #1a7f37 #633c01 #0550ae #6639ba #136061 #57606a`),
};

/** A theme without its own palette: ANSI colours from its syntax colours. */
function derivedPalette(theme: EditorTheme): AnsiPalette {
  const { ui, syntax } = theme;
  const dark = theme.appearance === "dark";
  const base = [
    dark ? ui.card : ui.foreground, syntax.keyword, syntax.string, syntax.number,
    syntax.property, syntax.constant, syntax.operator, dark ? ui.foreground : ui.mutedForeground,
  ];
  return palette([...base, ui.mutedForeground, ...base.slice(1, 7), dark ? ui.foreground : ui.mutedForeground].join(" "));
}

/** What the `aed.terminal` view's `theme` prop takes. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  /** Drawn over selected cells; its alpha shows the text through. */
  selection: string;
  /** The 16 ANSI colours, in ANSI order. */
  palette: string[];
}

/** An app theme as the terminal's: `theme.ui` planes plus the 16 ANSI colours. */
export function buildTerminalTheme(theme: EditorTheme): TerminalTheme {
  const { ui } = theme;
  const ansi = ANSI_PALETTES[theme.id] ?? derivedPalette(theme);
  return {
    background: ui.background,
    foreground: ui.foreground,
    cursor: ui.accent,
    selection: ui.selection,
    palette: ANSI_NAMES.map((name) => ansi[name]),
  };
}
