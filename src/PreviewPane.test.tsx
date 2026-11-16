import { describe, expect, open, test } from "nsh/test";
import { classifyFile } from "./classify";
import { buildQuickOpenItems, OPEN_FOLDER_CMD_ID } from "./commands";
import * as PreviewPaneMod from "./PreviewPane";
import {
  clampRevealPosition,
  formatSearchCount,
  reconstructBaseFromPatch,
  resolveDiffInputs,
  resolveImageBackdrop,
} from "./PreviewPane";
import { createTabStore } from "./tabs";
import type { LoadedFile } from "./workspace";
import { computeTabModeItems } from "./workspaceSession";

function sampleFile(filePath: string, overrides: Partial<LoadedFile> = {}): LoadedFile {
  const classification = overrides.classification ?? classifyFile(filePath);
  const name = filePath.split("/").pop() ?? filePath;
  const text = overrides.text ?? "line1\nline2\n";
  return {
    path: filePath,
    relPath: overrides.relPath ?? name,
    name,
    size: overrides.size ?? text.length,
    classification,
    mode: overrides.mode ?? classification.defaultMode,
    gitStatus: overrides.gitStatus,
    text,
    savedText: overrides.savedText ?? text,
    dirty: overrides.dirty ?? false,
    blobUrl: null,
    quickLookUrl: null,
    dimensions: null,
    tableData: null,
    hexDump: "",
    diffPatch: overrides.diffPatch ?? "",
    diskStamp: "1:10",
    diskChanged: false,
    diskMissing: false,
    bom: false,
    readOnly: null,
    saveError: null,
  };
}

describe("PreviewPane, mode pills & Quick Open pure contracts", () => {
  test("formatSearchCount formats tabular current+1/count and 0/0 when empty or unmatched", () => {
    expect(formatSearchCount(null, false)).toBe("0/0");
    expect(formatSearchCount({ count: 4, current: 0 }, false)).toBe("0/0");
    expect(formatSearchCount({ count: 0, current: null }, true)).toBe("0/0");
    expect(formatSearchCount({ count: 5, current: 0 }, true)).toBe("1/5");
    expect(formatSearchCount({ count: 5, current: 2 }, true)).toBe("3/5");
  });

  test("clampRevealPosition scans newlines without splitting and clamps past bounds", () => {
    const text = "alpha\nbeta-line\r\ngamma";
    expect(clampRevealPosition(text, 1, 1)).toEqual({ line: 0, column: 0 });
    expect(clampRevealPosition(text, 2, 5)).toEqual({ line: 1, column: 4 });
    // Excludes trailing \r on CRLF lines.
    expect(clampRevealPosition(text, 2, 99)).toEqual({ line: 1, column: 9 });
    // Past last line clamps to last line.
    expect(clampRevealPosition(text, 99, 3)).toEqual({ line: 2, column: 2 });
  });

  test("reconstructBaseFromPatch and resolveDiffInputs compare live buffer edits against HEAD or savedText", () => {
    const patch = [
      "diff --git a/note.ts b/note.ts",
      "--- a/note.ts",
      "+++ b/note.ts",
      "@@ -1,2 +1,2 @@",
      " const x = 1;",
      "-const old = 2;",
      "+const disk = 3;",
    ].join("\n");
    const saved = "const x = 1;\nconst disk = 3;\n";
    expect(reconstructBaseFromPatch(saved, patch)).toBe("const x = 1;\nconst old = 2;\n");

    const dirtyWithPatch = sampleFile("/w/note.ts", {
      savedText: saved,
      text: "const x = 1;\nconst unsaved = 4;\n",
      dirty: true,
      gitStatus: "M",
      diffPatch: patch,
    });
    expect(resolveDiffInputs(dirtyWithPatch)).toEqual({
      patch: undefined,
      oldValue: "const x = 1;\nconst old = 2;\n",
      newValue: "const x = 1;\nconst unsaved = 4;\n",
      status: "Git diff vs HEAD (unsaved)",
    });

    const cleanDiffFile = sampleFile("/w/fix.diff", {
      text: patch,
      savedText: "",
      dirty: true,
    });
    expect(resolveDiffInputs(cleanDiffFile).patch).toBe(patch);
  });

  test("resolveImageBackdrop names the target backdrop polarity on both light and dark themes", () => {
    expect(resolveImageBackdrop("light", "#efebe3", false)).toEqual({
      backgroundColor: "#efebe3",
      toggleLabel: "Dark BG",
    });
    expect(resolveImageBackdrop("light", "#efebe3", true)).toEqual({
      backgroundColor: "#1d1c1a",
      toggleLabel: "Light BG",
    });
    expect(resolveImageBackdrop("dark", "#161514", false)).toEqual({
      backgroundColor: "#161514",
      toggleLabel: "Light BG",
    });
    expect(resolveImageBackdrop("dark", "#161514", true)).toEqual({
      backgroundColor: "#f7f4ee",
      toggleLabel: "Dark BG",
    });
  });

  test("computeTabModeItems keeps [Diff] pill across Code/Preview switches and buildQuickOpenItems offers Open Folder…", () => {
    const store = createTabStore();
    const codeTab = store.openTab(
      sampleFile("/w/main.ts", { mode: "diff", gitStatus: "M", diffPatch: "@@ -1 +1 @@\n-a\n+b" }),
    );
    expect(computeTabModeItems(codeTab).map((i) => i.value)).toEqual(["source", "diff"]);

    // Switching from diff -> source keeps [Diff] pill available!
    store.setTabMode("/w/main.ts", "source");
    expect(computeTabModeItems(codeTab).map((i) => i.value)).toEqual(["source", "diff"]);

    // Modified Markdown exposes [Preview | Markdown | Diff].
    const mdTab = store.openTab(sampleFile("/w/guide.md", { gitStatus: "M" }));
    expect(computeTabModeItems(mdTab).map((i) => i.label)).toEqual(["Preview", "Markdown", "Diff"]);

    // Cold launch without workspace offers Open Folder… in Quick Open.
    const coldItems = buildQuickOpenItems("", [], []);
    expect(coldItems).toHaveLength(1);
    expect(coldItems[0].id).toBe(OPEN_FOLDER_CMD_ID);
    expect(coldItems[0].label).toBe("Open Folder…");
  });

  test("resolveEditorLayout wraps prose/markdown cleanly with airy 1.68x leading and keeps code unwrapped at 1.54x with 8-row scroll cushion", () => {
    const resolveEditorLayout = (
      PreviewPaneMod as unknown as {
        resolveEditorLayout?: (
          classification: { kind: string; language: string },
          fontSize: number,
        ) => {
          softWrap: boolean;
          lineHeight: number;
          scrollBeyondLastLine: number;
          classes: { line: string } | undefined;
        };
      }
    ).resolveEditorLayout;

    expect(typeof resolveEditorLayout).toBe("function");

    // Code files stay crisp & unwrapped with 1.54x leading (20pt at 13pt, 22pt at 14pt).
    expect(resolveEditorLayout!(classifyFile("main.ts"), 13)).toEqual({
      softWrap: false,
      lineHeight: 20,
      scrollBeyondLastLine: 8,
      classes: { line: "whitespace-nowrap" },
    });
    expect(resolveEditorLayout!(classifyFile("main.rs"), 14)).toEqual({
      softWrap: false,
      lineHeight: 22,
      scrollBeyondLastLine: 8,
      classes: { line: "whitespace-nowrap" },
    });

    // Plain text and Markdown source wrap cleanly with no whitespace-nowrap override and airy 1.68x leading.
    expect(resolveEditorLayout!(classifyFile("notes.txt"), 13)).toEqual({
      softWrap: true,
      lineHeight: 22,
      scrollBeyondLastLine: 8,
      classes: undefined,
    });
    expect(resolveEditorLayout!(classifyFile("README.md"), 14)).toEqual({
      softWrap: true,
      lineHeight: 24,
      scrollBeyondLastLine: 8,
      classes: undefined,
    });
  });

  test("headless Editor applies exact theme syntax colors, non-bold active line numbers, and framed FindBar", async () => {
    const fixtureRoot = decodeURIComponent(
      new URL("../fixtures", import.meta.url).pathname,
    ).replace(/\/+$/, "");
    const app = await open("../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: { "aed.theme": "tokyo-night" },
      host: { params: { openFile: `${fixtureRoot}/main.ts` } },
    });
    await app.waitFor("id:preview-editor");

    // Active line number 1 is crisp regular weight (no bold 700 width jump), inactive line 2 recedes at ~60% alpha.
    const activeNum = app.spanStyle("id:preview-editor >> text:1");
    expect(activeNum.fontWeight).toBe(400);
    expect(activeNum.color).toBe("#c0caf5ff");

    const mutedNum = app.spanStyle("id:preview-editor >> text:2");
    expect(mutedNum.color).toBe("#565f8999");

    // Inline style on EditorDecoration paints exact theme syntax colors (updating live across theme switches).
    await app.waitUntil(
      () => app.spanStyle("id:preview-editor >> text:export").color === "#bb9af7ff",
      { timeout: 1500 },
    );
    const kwSpan = app.spanStyle("id:preview-editor >> text:export");
    expect(kwSpan.color).toBe("#bb9af7ff");
    expect(kwSpan.fontWeight).toBe(600);

    // FindBar opens with framed search input.
    await app.keyboard.press("mod+f");
    await app.waitFor("id:editor-find-input");
    expect(app.shows("id:editor-find-input")).toBe(true);
  });
});
