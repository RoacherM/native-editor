import { computed } from "nsh";
import { describe, expect, test } from "nsh/test";
import { classifyFile } from "./classify";
import { saveInStore } from "./saving";
import { applyTabLocation, createTabStore, toLoadedFileSnapshot } from "./tabs";
import type { LoadedFile } from "./workspace";

function makeLoaded(
  filePath: string,
  opts: Partial<LoadedFile> = {},
): LoadedFile {
  const classification = opts.classification ?? classifyFile(filePath);
  const name = filePath.split("/").pop() ?? filePath;
  const text = opts.text ?? "line1\nline2\nline3\n";
  return {
    path: filePath,
    relPath: opts.relPath ?? name,
    name,
    size: opts.size ?? text.length,
    classification,
    mode: opts.mode ?? classification.defaultMode,
    gitStatus: opts.gitStatus,
    text,
    savedText: opts.savedText ?? text,
    dirty: opts.dirty ?? false,
    blobUrl: opts.blobUrl ?? null,
    quickLookUrl: opts.quickLookUrl ?? null,
    dimensions: opts.dimensions ?? null,
    tableData: opts.tableData ?? null,
    hexDump: opts.hexDump ?? "",
    diffPatch: opts.diffPatch ?? "",
    diskStamp: opts.diskStamp === undefined ? "100:18" : opts.diskStamp,
    diskChanged: opts.diskChanged ?? false,
    diskMissing: opts.diskMissing ?? false,
    bom: opts.bom ?? false,
    readOnly: opts.readOnly ?? null,
    saveError: opts.saveError ?? null,
  };
}

describe("L1.2 per-tab document & view session store (src/tabs.ts)", () => {
  test("keystrokes update tab.doc.text in O(1) without cloning tab list, bumping reloadSeq, or waking sibling tabs", () => {
    const store = createTabStore();
    const tabA = store.openTab(makeLoaded("/w/a.ts", { text: "const a = 1;\n" }));
    const tabB = store.openTab(makeLoaded("/w/b.ts", { text: "const b = 2;\n" }));

    let bTextReads = 0;
    let bDirtyReads = 0;
    let listReads = 0;

    const observeBText = computed(() => {
      bTextReads += 1;
      return tabB.doc.text();
    });
    const observeBDirty = computed(() => {
      bDirtyReads += 1;
      return tabB.doc.dirty();
    });
    const observePaths = computed(() => {
      listReads += 1;
      return store.openPaths();
    });

    expect(observeBText()).toBe("const b = 2;\n");
    expect(observeBDirty()).toBe(false);
    expect(observePaths()).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(bTextReads).toBe(1);
    expect(bDirtyReads).toBe(1);
    expect(listReads).toBe(1);

    // 25 keystrokes in tabA: zero wakeups on tabB or openPaths, reloadSeq stays 0!
    for (let i = 1; i <= 25; i += 1) {
      store.updateTabBufferText("/w/a.ts", `const a = ${i};\n`);
    }
    expect(tabA.doc.text()).toBe("const a = 25;\n");
    expect(tabA.doc.dirty()).toBe(true);
    expect(tabA.doc.reloadSeq()).toBe(0);
    expect(store.dirtyPaths()).toEqual(["/w/a.ts"]);

    expect(observeBText()).toBe("const b = 2;\n");
    expect(observeBDirty()).toBe(false);
    expect(observePaths()).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(bTextReads).toBe(1);
    expect(bDirtyReads).toBe(1);
    expect(listReads).toBe(1);

    // Per-tab view state never bleeds across tabs.
    expect(tabA.view.cursor()).toEqual({ line: 1, col: 1 });
    expect(tabB.view.cursor()).toEqual({ line: 1, col: 1 });
    tabA.view.cursor.set({ line: 12, col: 5 });
    tabA.view.zoom.set(175);
    tabA.view.contrastBg.set(true);
    tabA.view.scrollY.set(420);
    expect(tabB.view.cursor()).toEqual({ line: 1, col: 1 });
    expect(tabB.view.zoom()).toBe(100);
    expect(tabB.view.contrastBg()).toBe(false);
    expect(tabB.view.scrollY()).toBe(0);
  });

  test("disjoint diskStatus transitions cleanly from conflict -> missing without DiskConflictBanner deadlock", async () => {
    const store = createTabStore();
    const tab = store.openTab(makeLoaded("/w/note.txt", { text: "v1\n", diskStamp: "100:3" }));
    store.updateTabBufferText("/w/note.txt", "v1 edited\n");
    expect(tab.doc.diskStatus()).toBe("synced");

    // External disk edit while dirty -> "conflict".
    const becameConflict = await store.reconcileTabDisk("/w/note.txt", {
      stamp: "200:5",
      size: 5,
      isFile: true,
      isDirectory: false,
    });
    expect(becameConflict).toBe(true);
    expect(tab.doc.diskStatus()).toBe("conflict");
    expect(toLoadedFileSnapshot(tab)).toMatchObject({
      diskChanged: true,
      diskMissing: false,
    });

    // Deleting the conflicted file on disk transitions "conflict" -> "missing" (disjoint!).
    const becameMissing = await store.reconcileTabDisk("/w/note.txt", null);
    expect(becameMissing).toBe(true);
    expect(tab.doc.diskStatus()).toBe("missing");
    expect(toLoadedFileSnapshot(tab)).toMatchObject({
      diskChanged: false,
      diskMissing: true,
    });

    // Keep My Edits when file is recreated/chosen adopts new stamp and clears status to "synced".
    store.keepTabEdits("/w/note.txt", "300:10");
    expect(tab.doc.diskStatus()).toBe("synced");
    expect(tab.doc.diskStamp()).toBe("300:10");
    expect(tab.doc.dirty()).toBe(true);
    expect(tab.doc.reloadSeq()).toBe(0);

    // Reload from Disk replaces buffer, clears dirty & conflict, and increments reloadSeq.
    store.reloadTab(
      "/w/note.txt",
      makeLoaded("/w/note.txt", { text: "disk fresh\n", diskStamp: "400:11" }),
    );
    expect(tab.doc.text()).toBe("disk fresh\n");
    expect(tab.doc.dirty()).toBe(false);
    expect(tab.doc.diskStatus()).toBe("synced");
    expect(tab.doc.reloadSeq()).toBe(1);

    // Clean tab external edit auto-reloads and increments reloadSeq to 2.
    const cleanReloaded = await store.reconcileTabDisk(
      "/w/note.txt",
      { stamp: "500:12", size: 12, isFile: true, isDirectory: false },
      async () => makeLoaded("/w/note.txt", { text: "disk v2\n", diskStamp: "500:12" }),
    );
    expect(cleanReloaded).toBe(true);
    expect(tab.doc.text()).toBe("disk v2\n");
    expect(tab.doc.reloadSeq()).toBe(2);
  });

  test("applyTabLocation switches rich-preview tabs (guide.md:25, .mmd, .html, .svg) to source mode and sets pendingReveal", () => {
    const store = createTabStore();

    // guide.md:25 opens in source mode instead of staying stuck in preview!
    const mdTab = store.openTab(makeLoaded("/w/guide.md"), {
      location: { line: 25, column: 3 },
    });
    expect(mdTab.doc.mode()).toBe("source");
    expect(mdTab.view.pendingReveal()).toEqual({ line: 25, column: 3 });

    // Switching back to preview, then jumping to line 12 via applyTabLocation switches back to source.
    store.setTabMode("/w/guide.md", "preview");
    expect(mdTab.doc.mode()).toBe("preview");
    applyTabLocation(mdTab, { line: 12 });
    expect(mdTab.doc.mode()).toBe("source");
    expect(mdTab.view.pendingReveal()).toEqual({ line: 12, column: 0 });

    // .mmd, .html, and .svg also switch to source on line reveal.
    const mmdTab = store.openTab(makeLoaded("/w/arch.mmd"), { location: { line: 7 } });
    const htmlTab = store.openTab(makeLoaded("/w/index.html"), { location: { line: 19, column: 2 } });
    const svgTab = store.openTab(makeLoaded("/w/icon.svg"), { location: { line: 4 } });
    expect(mmdTab.doc.mode()).toBe("source");
    expect(htmlTab.doc.mode()).toBe("source");
    expect(svgTab.doc.mode()).toBe("source");

    // Line 0 or opaque PNG never switches mode or sets pendingReveal.
    const plainMd = store.openTab(makeLoaded("/w/README.md"), { location: { line: 0, column: 0 } });
    expect(plainMd.doc.mode()).toBe("preview");
    expect(plainMd.view.pendingReveal()).toBeNull();

    const pngTab = store.openTab(makeLoaded("/w/poster.png", { blobUrl: "blob:png-0" }), {
      location: { line: 10, column: 1 },
    });
    expect(pngTab.doc.mode()).toBe("preview");
    expect(pngTab.view.pendingReveal()).toBeNull();
  });

  test("revokes blob: URLs deterministically once on reload, SVG save, close, and resetTabs (never revoking file paths)", async () => {
    const revoked: string[] = [];
    const store = createTabStore({ revokeUrl: (u) => revoked.push(u) });

    store.openTab(makeLoaded("/w/poster.png", { blobUrl: "blob:png-1" }));
    const svgTab = store.openTab(
      makeLoaded("/w/icon.svg", { text: "<svg>1</svg>", blobUrl: "blob:svg-1" }),
    );
    store.openTab(makeLoaded("/w/clip.mp4", { blobUrl: "/w/clip.mp4" }));
    expect(revoked).toEqual([]);

    // 1. Reload poster.png with new blob URL -> revokes blob:png-1 once.
    store.reloadTab("/w/poster.png", makeLoaded("/w/poster.png", { blobUrl: "blob:png-2" }));
    expect(revoked).toEqual(["blob:png-1"]);

    // 2. Save edited SVG via saveInStore(store.fileStore) -> revokes blob:svg-1 once, preserves in-flight typing, keeps reloadSeq=0.
    store.updateTabBufferText("/w/icon.svg", "<svg>2</svg>");
    let finishWrite: () => void = () => undefined;
    const savePromise = saveInStore(store.fileStore, "/w/icon.svg", (file, text) => {
      return new Promise<LoadedFile>((resolve) => {
        finishWrite = () =>
          resolve({
            ...file,
            text,
            savedText: text,
            dirty: false,
            blobUrl: "blob:svg-2",
            diskStamp: "200:12",
          });
      });
    });
    // User types while SVG write is in flight.
    store.updateTabBufferText("/w/icon.svg", "<svg>3</svg>");
    finishWrite();
    expect(await savePromise).toBe("saved");
    expect(revoked).toEqual(["blob:png-1", "blob:svg-1"]);
    expect(svgTab.doc.blobUrl()).toBe("blob:svg-2");
    expect(svgTab.doc.text()).toBe("<svg>3</svg>");
    expect(svgTab.doc.savedText()).toBe("<svg>2</svg>");
    expect(svgTab.doc.dirty()).toBe(true);
    expect(svgTab.doc.reloadSeq()).toBe(0);

    // 3. Closing poster.png revokes blob:png-2; closing clip.mp4 never revokes non-blob file path.
    store.closeTab("/w/poster.png");
    store.closeTab("/w/clip.mp4");
    expect(revoked).toEqual(["blob:png-1", "blob:svg-1", "blob:png-2"]);

    // 4. resetTabs revokes all remaining blob URLs once and clears state.
    store.openTab(makeLoaded("/w/extra.png", { blobUrl: "blob:extra-1" }));
    revoked.length = 0;
    store.resetTabs();
    expect(revoked).toEqual(["blob:svg-2", "blob:extra-1"]);
    expect(store.tabs()).toEqual([]);
    expect(store.activePath()).toBeNull();
  });

  test("migrateRenamedTabs relocates file & folder renames while preserving tab identity and all doc/view signals", () => {
    const store = createTabStore();
    const tab = store.openTab(makeLoaded("/w/old-dir/guide.md", { relPath: "old-dir/guide.md" }));
    const stableId = tab.id;
    store.updateTabBufferText("/w/old-dir/guide.md", "# Draft\n");
    tab.doc.diskStatus.set("missing");
    tab.view.cursor.set({ line: 8, col: 4 });
    tab.view.zoom.set(150);
    tab.view.contrastBg.set(true);
    tab.view.scrollY.set(280);

    const untouched = store.openTab(makeLoaded("/w/keep.ts"), { activate: false });
    expect(store.activePath()).toBe("/w/old-dir/guide.md");

    store.migrateRenamedTabs([["/w/old-dir", "/w/new-dir"]], "/w");

    expect(store.getTab("/w/old-dir/guide.md")).toBeUndefined();
    const moved = store.getTab("/w/new-dir/guide.md");
    expect(moved).toBe(tab);
    expect(moved?.id).toBe(stableId);
    expect(moved?.path()).toBe("/w/new-dir/guide.md");
    expect(moved?.doc.file().relPath).toBe("new-dir/guide.md");
    expect(moved?.doc.file().name).toBe("guide.md");
    expect(moved?.doc.text()).toBe("# Draft\n");
    expect(moved?.doc.dirty()).toBe(true);
    expect(moved?.doc.diskStatus()).toBe("synced");
    expect(moved?.view.cursor()).toEqual({ line: 8, col: 4 });
    expect(moved?.view.zoom()).toBe(150);
    expect(moved?.view.contrastBg()).toBe(true);
    expect(moved?.view.scrollY()).toBe(280);
    expect(store.activePath()).toBe("/w/new-dir/guide.md");
    expect(store.openPaths()).toEqual(["/w/new-dir/guide.md", "/w/keep.ts"]);
    expect(store.getTab("/w/keep.ts")).toBe(untouched);
  });
});
