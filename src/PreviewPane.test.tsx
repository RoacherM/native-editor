import { describe, expect, test } from "nsh/test";
import { classifyFile } from "./classify";
import { buildQuickOpenItems, OPEN_FOLDER_CMD_ID } from "./commands";
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
});
