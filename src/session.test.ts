import { describe, expect, test } from "nsh/test";
import { classifyFile } from "./classify";
import { describeFailure, saveInStore, settleSavedCopy } from "./saving";
import {
  canToggleSidebar,
  decideGuard,
  deriveEditorSurface,
  deriveWindowMode,
  externalOpenKeepsTree,
  type ExternalOrigin,
  nextActiveAfterClose,
  normalizeRoot,
  planWorkspaceIntent,
  runApprovedQuit,
  serialize,
  unsavedQuestion,
  WINDOW_TRANSITIONS,
  type WindowEvent,
  type WindowMode,
  windowTitle,
} from "./session";
import type { LoadedFile } from "./workspace";

interface SessionSim {
  root: string;
  tabs: string[];
}

const SIM_STATES: Record<WindowMode, SessionSim> = {
  home: { root: "", tabs: [] },
  workspace: { root: "/w/cur", tabs: ["/w/cur/a.ts"] },
  loose: { root: "", tabs: ["/elsewhere/n.md"] },
};

function openExternal(s: SessionSim, file: string, origin: ExternalOrigin): SessionSim {
  const root = externalOpenKeepsTree(origin) ? s.root : "";
  return { root, tabs: [...s.tabs, file] };
}

function applyWorkspace(s: SessionSim, plan: ReturnType<typeof planWorkspaceIntent>): SessionSim {
  return plan.action === "reset" ? { root: plan.nextRoot, tabs: [] } : s;
}

/** Replays one event through the same session.ts rules App.tsx runs. */
function applySessionEvent(s: SessionSim, event: WindowEvent): SessionSim {
  switch (event) {
    case "open-folder":
      return applyWorkspace(s, planWorkspaceIntent(s.root, s.tabs.length, { kind: "open", root: "/w/other/" }));
    case "reopen-current-folder":
      return applyWorkspace(s, planWorkspaceIntent(s.root, s.tabs.length, { kind: "open", root: s.root || "/w/cur" }));
    case "close-folder":
      return applyWorkspace(s, planWorkspaceIntent(s.root, s.tabs.length, { kind: "close" }));
    case "drop-file":
      return openExternal(s, "/elsewhere/dropped.md", "drop");
    case "click-file":
      // Even a file from inside the open folder: clicks are tree-less (I-007).
      return openExternal(s, `${s.root || "/w/cur"}/b.ts`, "click");
    case "close-last-tab":
      return { root: s.root, tabs: [] };
  }
}

/** A clean in-memory copy of a text file, for the save rules. */
function textCopy(filePath: string, text: string): LoadedFile {
  return {
    path: filePath,
    relPath: filePath.split("/").pop() ?? filePath,
    name: filePath.split("/").pop() ?? filePath,
    size: text.length,
    classification: classifyFile(filePath),
    mode: "source",
    text,
    savedText: text,
    dirty: false,
    blobUrl: null,
    quickLookUrl: null,
    tableData: null,
    hexDump: "",
    diffPatch: "",
    diskStamp: "1:1",
    diskChanged: false,
    diskMissing: false,
    bom: false,
    readOnly: null,
    saveError: null,
  };
}

describe("window session state machine (src/session.ts)", () => {
  test("every WINDOW_TRANSITIONS cell matches the rules App.tsx runs", () => {
    for (const mode of Object.keys(WINDOW_TRANSITIONS) as WindowMode[]) {
      const start = SIM_STATES[mode];
      expect(deriveWindowMode(start.root, start.tabs.length)).toBe(mode);
      for (const event of Object.keys(WINDOW_TRANSITIONS[mode]) as WindowEvent[]) {
        const end = applySessionEvent(start, event);
        expect(`${mode} --${event}--> ${deriveWindowMode(end.root, end.tabs.length)}`).toBe(
          `${mode} --${event}--> ${WINDOW_TRANSITIONS[mode][event]}`
        );
      }
    }
    // Reopening the open folder keeps its tabs instead of resetting them.
    expect(applySessionEvent(SIM_STATES.workspace, "reopen-current-folder").tabs).toEqual(["/w/cur/a.ts"]);
  });

  test("workspace intents, editor surface, guard and tab-close rules", () => {
    expect(normalizeRoot("/w/cur///")).toBe("/w/cur");
    expect(normalizeRoot("/")).toBe("");
    expect(canToggleSidebar("")).toBe(false);
    expect(canToggleSidebar("/w/cur")).toBe(true);

    expect(planWorkspaceIntent("/w/cur", 2, { kind: "open", root: "/w/cur/" })).toEqual({ action: "refresh" });
    expect(planWorkspaceIntent("/w/cur", 2, { kind: "open", root: "/" })).toEqual({ action: "ignore" });
    expect(planWorkspaceIntent("", 0, { kind: "close" })).toEqual({ action: "ignore" });
    expect(planWorkspaceIntent("", 1, { kind: "close" })).toEqual({ action: "reset", nextRoot: "" });
    expect(externalOpenKeepsTree("drop")).toBe(true);
    expect(externalOpenKeepsTree("click")).toBe(false);

    expect(deriveEditorSurface("", false)).toBe("welcome");
    expect(deriveEditorSurface("/w", false)).toBe("workspace-empty");
    expect(deriveEditorSurface("", true)).toBe("file");

    const pending = { action: "close-tab" as const, dirtyPaths: ["/w/a.ts"], onProceed: () => {} };
    expect(decideGuard(null, [])).toBe("run");
    expect(decideGuard(null, ["/w/a.ts"])).toBe("confirm");
    expect(decideGuard(pending, [])).toBe("busy");

    expect(unsavedQuestion("close-tab", "a.ts")).toBe("Save changes to a.ts before closing?");
    expect(unsavedQuestion("close-folder", "a.ts")).toBe("Save changes to a.ts before closing the folder?");
    expect(unsavedQuestion("switch-folder", "a.ts")).toBe("Save changes to a.ts before opening another folder?");
    expect(unsavedQuestion("quit", "a.ts")).toBe("Save changes to a.ts before quitting?");

    expect(nextActiveAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(nextActiveAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
    expect(nextActiveAfterClose(["a", "b"], "a", "b")).toBe("b");
    expect(nextActiveAfterClose(["a", "b"], "b", "b")).toBe("a");
    expect(nextActiveAfterClose(["a"], "a", "a")).toBeNull();
  });

  test("the disk check never overlaps itself and runs once more after calls made meanwhile", async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const check = serialize(() => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = check();
    await check(); // returns at once: a run is in flight
    await check();
    expect(runs).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2); // the calls made meanwhile give exactly one more run
    release();
    await first;
    expect(runs).toBe(2);
  });

  test("the disk check runs again after a run that threw", async () => {
    let runs = 0;
    let fail: (e: unknown) => void = () => undefined;
    const check = serialize(() => {
      runs += 1;
      if (runs > 1) return Promise.resolve();
      return new Promise<void>((_, reject) => (fail = reject));
    });
    const first = check().catch(() => undefined);
    void check(); // queued while the first run is in flight
    fail(new Error("disk gone"));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    await check();
    expect(runs).toBe(3); // no stale rerun left over
  });

  test("the window title carries the edited mark scripts/finder_bridge.m reads", () => {
    expect(windowTitle(false)).toBe("Aed");
    expect(windowTitle(true)).toBe("Aed — Edited");
  });

  test("a quit the host does not carry out arms the guard again", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const refused: boolean[] = [];
    runApprovedQuit(
      (v) => refused.push(v),
      () => {
        throw new Error("process.exit is not granted");
      }
    );
    await sleep(10);
    expect(refused).toEqual([true, false]);
    const cancelled: boolean[] = [];
    runApprovedQuit((v) => cancelled.push(v), () => undefined, 20);
    await sleep(80);
    expect(cancelled).toEqual([true, false]);
  });
});

describe("tab saving rules (src/saving.ts)", () => {
  test("typing while a save is in flight stays dirty with the newest text", async () => {
    const files = new Map<string, LoadedFile>();
    const store = {
      get: (p: string) => files.get(p),
      set: (p: string, f: LoadedFile) => void files.set(p, f),
    };
    let finish: () => void = () => undefined;
    const write = (file: LoadedFile, text: string) =>
      new Promise<LoadedFile>((resolve) => {
        finish = () => resolve({ ...file, text, savedText: text, dirty: false });
      });
    const edit = (p: string, text: string) => {
      const cur = files.get(p) as LoadedFile;
      files.set(p, { ...cur, text, dirty: text !== cur.savedText });
    };
    files.set("/w/a.txt", textCopy("/w/a.txt", "v1"));
    edit("/w/a.txt", "v2");
    const saving = saveInStore(store, "/w/a.txt", write);
    edit("/w/a.txt", "v3"); // typed while the write is in flight
    finish();
    expect(await saving).toBe("saved");
    expect(files.get("/w/a.txt")).toMatchObject({ text: "v3", savedText: "v2", dirty: true });

    // A tab closed while its save was in flight is not written back.
    files.set("/w/b.txt", textCopy("/w/b.txt", "b1"));
    edit("/w/b.txt", "b2");
    const closing = saveInStore(store, "/w/b.txt", write);
    files.delete("/w/b.txt");
    finish();
    await closing;
    expect(files.has("/w/b.txt")).toBe(false);

    // A clean copy is never written.
    files.set("/w/c.txt", textCopy("/w/c.txt", "c1"));
    expect(await saveInStore(store, "/w/c.txt", write)).toBe("skipped");
  });

  test("records write failures on the open copy without throwing and preserves mode on settle", async () => {
    const files = new Map<string, LoadedFile>();
    const store = {
      get: (p: string) => files.get(p),
      set: (p: string, f: LoadedFile) => void files.set(p, f),
    };
    const dirty = { ...textCopy("/w/err.txt", "v2"), savedText: "v1", dirty: true };
    files.set("/w/err.txt", dirty);
    const outcome = await saveInStore(store, "/w/err.txt", async () => {
      throw new Error("permission denied");
    });
    expect(outcome).toBe("failed");
    expect(files.get("/w/err.txt")?.saveError).toBe("Could not save /w/err.txt: permission denied");
    expect(describeFailure("open", "x.md", "bad")).toBe("Could not open x.md: bad");

    const settled = settleSavedCopy(
      { ...dirty, mode: "diff", text: "v2" },
      { ...dirty, savedText: "v2", dirty: false }
    );
    expect(settled.mode).toBe("diff");
    expect(settled.dirty).toBe(false);
  });
});
