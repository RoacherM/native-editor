import { describe, expect, test } from "nsh/test";
import {
  buildEditorThemeStyles,
  buildThemeTokens,
  computeSyntaxDecorations,
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  getThemeById,
  syncThemeTokens,
} from "./themes";

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "").slice(0, 6);
  const channels = [0, 2, 4].map((offset) => {
    const srgb = Number.parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

describe("L0.4 unified theme tokens & WCAG contrast", () => {
  test("all 8 themes satisfy WCAG >= 4.5 for accentForeground and distinct statusBar", () => {
    expect(EDITOR_THEMES).toHaveLength(8);
    expect(getThemeById(DEFAULT_THEME_ID).id).toBe("industrial-paper");

    for (const theme of EDITOR_THEMES) {
      expect(theme.ui.accentForeground).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(contrastRatio(theme.ui.accentForeground, theme.ui.accent)).toBeGreaterThanOrEqual(4.5);

      expect(theme.ui.statusBar).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.ui.statusBarForeground).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.ui.statusBar).not.toBe(theme.ui.sidebar);
      expect(theme.ui.statusBar).not.toBe(theme.ui.background);
      expect(
        contrastRatio(theme.ui.statusBarForeground!, theme.ui.statusBar!)
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Pastel-accent dark themes exceed AAA 7:1 contrast on primary buttons.
    for (const id of [
      "kanagawa-dragon",
      "tokyo-night",
      "catppuccin-mocha",
      "one-dark",
      "rose-pine",
    ]) {
      const t = getThemeById(id);
      expect(contrastRatio(t.ui.accentForeground, t.ui.accent)).toBeGreaterThanOrEqual(7);
    }
  });

  test("all 8 themes align syntaxClasses to exact theme.syntax hex colors", () => {
    const keys = [
      "keyword",
      "string",
      "number",
      "comment",
      "property",
      "type",
      "function",
      "constant",
      "operator",
      "tag",
    ] as const;

    for (const theme of EDITOR_THEMES) {
      for (const k of keys) {
        expect(theme.syntaxClasses[k]).toContain(`text-[${theme.syntax[k].toLowerCase()}]`);
      }
    }
  });

  test("buildThemeTokens maps semantic NSH tokens and syncThemeTokens no-ops safely headless", async () => {
    const catppuccin = getThemeById("catppuccin-mocha");
    const tokens = buildThemeTokens(catppuccin);

    expect(tokens.background).toBe(catppuccin.ui.background);
    expect(tokens.foreground).toBe(catppuccin.ui.foreground);
    expect(tokens.card).toBe(catppuccin.ui.card);
    expect(tokens["card-foreground"]).toBe(catppuccin.ui.foreground);
    expect(tokens.popover).toBe(catppuccin.ui.card);
    expect(tokens["popover-foreground"]).toBe(catppuccin.ui.foreground);
    expect(tokens.primary).toBe(catppuccin.ui.accent);
    expect(tokens["primary-foreground"]).toBe(catppuccin.ui.accentForeground);
    expect(tokens.secondary).toBe(catppuccin.ui.sidebar);
    expect(tokens.muted).toBe(catppuccin.ui.sidebar);
    expect(tokens["muted-foreground"]).toBe(catppuccin.ui.mutedForeground);
    expect(tokens.accent).toBe(catppuccin.ui.activeLine);
    expect(tokens["accent-foreground"]).toBe(catppuccin.ui.foreground);
    expect(tokens.border).toBe(catppuccin.ui.border);
    expect(tokens.input).toBe(catppuccin.ui.border);
    expect(tokens.ring).toBe(catppuccin.ui.accent);
    expect(tokens.sidebar).toBe(catppuccin.ui.sidebar);
    expect(tokens["sidebar-primary"]).toBe(catppuccin.ui.accent);
    expect(tokens["sidebar-primary-foreground"]).toBe(catppuccin.ui.accentForeground);

    await syncThemeTokens(catppuccin);
  });

  test("buildEditorThemeStyles makes gutter flush with canvas, breathes content, recedes line numbers, and softens guides", () => {
    for (const theme of EDITOR_THEMES) {
      const styles = buildEditorThemeStyles(theme);
      expect(styles.gutter).toEqual({
        backgroundColor: theme.ui.background,
        paddingBottom: 16,
        paddingLeft: 16,
        paddingRight: 14,
      });
      expect(styles.content).toEqual({
        backgroundColor: theme.ui.background,
        paddingTop: 12,
        paddingBottom: 24,
        paddingLeft: 6,
        paddingRight: 28,
      });
      expect(styles.lineNumber).toEqual({
        color: `${theme.ui.mutedForeground}99`,
        fontVariant: ["tabular-nums"],
      });
      expect(styles.activeLineNumber).toEqual({
        color: theme.ui.foreground,
        fontVariant: ["tabular-nums"],
      });
      expect(styles.foldMarker).toMatchObject({
        color: `${theme.ui.mutedForeground}99`,
      });
      expect(styles.indentGuide).toEqual({
        backgroundColor: `${theme.ui.border}66`,
      });
      expect(styles.matchingBracket).toMatchObject({
        backgroundColor: `${theme.ui.accent}24`,
      });
    }
  });
});

describe("L0.4 2400-line bounded syntax cache, inline style emission & zero-alloc identifier scan", () => {
  test("decorates up to 2400 lines / 12000 tokens with inline style + class and hits O(1) cache below line 2400", () => {
    const tokyo = getThemeById("tokyo-night");
    const headLines = Array.from(
      { length: 2400 },
      (_, i) => `export const v${i}: number = ${i}; // note ${i}`
    ).join("\n");
    const tailV1 = "\n" + "const tail = 'a';\n".repeat(10_000);
    const tailV2 = "\n" + "const tail = 'b_edited_below_line_2400';\n".repeat(12_000);

    const first = computeSyntaxDecorations(
      headLines + tailV1,
      "typescript",
      tokyo,
      "/repo/big.ts\0tokyo-night"
    );
    expect(first.length).toBeGreaterThan(4000);
    expect(first.length).toBeLessThanOrEqual(12_000);

    // Lines well past the old 600-line ceiling keep exact theme syntax highlighting.
    const lateLineDeco = first.find((d) => d.range.start.line >= 1800 && d.token === "keyword");
    expect(lateLineDeco).toBeDefined();
    expect(lateLineDeco?.class).toContain(`text-[${tokyo.syntax.keyword}]`);
    expect(lateLineDeco?.style).toEqual({
      color: tokyo.syntax.keyword,
      fontWeight: "600",
    });

    const commentDeco = first.find((d) => d.range.start.line >= 1800 && d.token === "comment");
    expect(commentDeco?.style).toEqual({
      color: tokyo.syntax.comment,
      fontStyle: "italic",
    });

    // Typing below line 2400 hits the exact cached decoration array reference.
    const second = computeSyntaxDecorations(
      headLines + tailV2,
      "typescript",
      tokyo,
      "/repo/big.ts\0tokyo-night"
    );
    expect(second).toBe(first);

    // Editing line 1 invalidates the cached head slice for that key and recomputes.
    const editedHead = headLines.replace("export const v0", "const renamed0");
    const third = computeSyntaxDecorations(
      editedHead + tailV2,
      "typescript",
      tokyo,
      "/repo/big.ts\0tokyo-night"
    );
    expect(third).not.toBe(first);
  });

  test("distinguishes object properties (foo : 1) from Rust/C++ paths (foo::bar) and emits hex style + class for raw SyntaxPalette", () => {
    const kanagawa = getThemeById("kanagawa-dragon");
    const src = "const obj = { alpha   : 42 };\nlet x = std::mem::take(y);";
    const decos = computeSyntaxDecorations(src, "rust", kanagawa.syntax);

    const alphaDeco = decos.find((d) => d.range.start.line === 0 && d.range.start.column === 14);
    expect(alphaDeco?.token).toBe("attr");
    expect(alphaDeco?.class).toBe(`text-[${kanagawa.syntax.property}]`);
    expect(alphaDeco?.style).toEqual({ color: kanagawa.syntax.property });

    const stdDeco = decos.find((d) => d.range.start.line === 1 && d.range.start.column === 8);
    expect(stdDeco).toBeUndefined();
  });
});
