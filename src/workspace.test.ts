import * as path from "path";
import { effect, signal } from "nsh";
import { describe, expect, test } from "nsh/test";
import { classifyFile } from "./classify";
import {
  allowsMode,
  canSaveFile,
  detectRenames,
  deferOutOfEffect,
  emptySnapshot,
  externalFileCandidates,
  getPreloadedFile,
  loadFile,
  loadTabFile,
  MAX_EDITABLE_BYTES,
  MAX_PREVIEW_HEAD_BYTES,
  nextPollDelayMs,
  normalizeExternalFilePath,
  onceAsync,
  readGitStatus,
  resolveExternalFileReference,
  scanWorkspace,
  statDisk,
  syncWindowStateFile,
  warmWorkspaceFiles,
  watchActiveInterval,
  withGitStatus,
  type DiskStat,
  type WorkspaceEntry,
  type WorkspaceIoDeps,
} from "./workspace";

interface FakeFsEntry {
  kind: "file" | "dir" | "symlink" | "unreadable";
  bytes?: Uint8Array;
  mtimeMs?: number;
  size?: number;
}

function makeFakeIo(initial: Record<string, FakeFsEntry> = {}) {
  const entries = new Map<string, FakeFsEntry>(Object.entries(initial));
  let statCalls = 0;
  let readFileCalls = 0;
  let headCalls: Array<{ path: string; count: number }> = [];
  let gitCalls: string[][] = [];
  let inFlightReaddir = 0;
  let maxInFlightReaddir = 0;
  let readdirDelayMs = 0;
  let gitExitCode = 0;
  let gitStatusStdout = "";
  let gitBranchStdout = "main\n";

  const statImpl = async (p: string) => {
    statCalls += 1;
    const norm = path.normalize(p);
    const hit = entries.get(norm);
    if (!hit || hit.kind === "unreadable") {
      const err = Object.assign(new Error(`ENOENT: ${norm}`), { code: "ENOENT" });
      throw err;
    }
    const size = hit.size ?? hit.bytes?.byteLength ?? 0;
    const mtimeMs = hit.mtimeMs ?? 1000;
    return {
      size,
      mtimeMs,
      isFile: () => hit.kind === "file",
      isDirectory: () => hit.kind === "dir",
      isSymbolicLink: () => hit.kind === "symlink",
    };
  };

  const deps: WorkspaceIoDeps = {
    stat: statImpl,
    lstat: statImpl,
    readFile: async (p: string) => {
      readFileCalls += 1;
      const hit = entries.get(path.normalize(p));
      if (!hit || hit.kind !== "file") throw new Error(`ENOENT: ${p}`);
      return hit.bytes ?? new Uint8Array(0);
    },
    writeFile: async (p: string, data: string | Uint8Array) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const norm = path.normalize(p);
      const prev = entries.get(norm);
      entries.set(norm, {
        kind: "file",
        bytes,
        size: bytes.byteLength,
        mtimeMs: (prev?.mtimeMs ?? 1000) + 10,
      });
    },
    rename: async (from: string, to: string) => {
      const normFrom = path.normalize(from);
      const normTo = path.normalize(to);
      const val = entries.get(normFrom);
      if (!val) throw new Error(`ENOENT: ${normFrom}`);
      entries.delete(normFrom);
      entries.set(normTo, val);
    },
    unlink: async (p: string) => {
      entries.delete(path.normalize(p));
    },
    mkdir: async (p: string) => {
      const norm = path.normalize(p);
      if (!entries.has(norm)) entries.set(norm, { kind: "dir", mtimeMs: 1000 });
    },
    readdirDirents: async (dir: string) => {
      inFlightReaddir += 1;
      if (inFlightReaddir > maxInFlightReaddir) maxInFlightReaddir = inFlightReaddir;
      try {
        if (readdirDelayMs > 0) {
          await new Promise((r) => setTimeout(r, readdirDelayMs));
        }
        const normDir = path.normalize(dir);
        const dirEntry = entries.get(normDir);
        if (!dirEntry || dirEntry.kind === "unreadable") {
          throw new Error(`EACCES: ${normDir}`);
        }
        const prefix = normDir === "/" ? "/" : `${normDir}/`;
        const childNames = new Map<string, boolean>();
        for (const [k, v] of entries) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (!rest || rest.includes("/")) continue;
          childNames.set(rest, v.kind === "dir" || v.kind === "unreadable");
        }
        return [...childNames.entries()].map(([name, isDir]) => ({
          name,
          isDirectory: () => isDir,
        }));
      } finally {
        inFlightReaddir -= 1;
      }
    },
    readdirNames: async (dir: string) => {
      const normDir = path.normalize(dir);
      const prefix = normDir === "/" ? "/" : `${normDir}/`;
      const names: string[] = [];
      for (const k of entries.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest && !rest.includes("/")) names.push(rest);
      }
      return names;
    },
    readHead: async (filePath: string, count: number) => {
      headCalls.push({ path: filePath, count });
      const hit = entries.get(path.normalize(filePath));
      if (!hit || !hit.bytes) throw new Error(`ENOENT: ${filePath}`);
      return hit.bytes.slice(0, count);
    },
    runGit: async (args: string[]) => {
      gitCalls.push(args);
      if (args.includes("status")) {
        return { code: gitExitCode, stdout: gitStatusStdout, stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { code: gitExitCode, stdout: gitBranchStdout, stderr: "" };
      }
      return { code: gitExitCode, stdout: "", stderr: "" };
    },
  };

  return {
    deps,
    entries,
    get statCalls() {
      return statCalls;
    },
    resetCounters() {
      statCalls = 0;
      readFileCalls = 0;
      headCalls = [];
      gitCalls = [];
      maxInFlightReaddir = 0;
    },
    get readFileCalls() {
      return readFileCalls;
    },
    get headCalls() {
      return headCalls;
    },
    get gitCalls() {
      return gitCalls;
    },
    get maxInFlightReaddir() {
      return maxInFlightReaddir;
    },
    setReaddirDelay(ms: number) {
      readdirDelayMs = ms;
    },
    setGitState(opts: { code: number; status?: string; branch?: string }) {
      gitExitCode = opts.code;
      gitStatusStdout = opts.status ?? "";
      gitBranchStdout = opts.branch ?? "";
    },
  };
}

describe("L1.1 workspace target wrappers & VIEWER_SPECS capability collapse", () => {
  test("collapses externalFileCandidates, normalizeExternalFilePath & resolveExternalFileReference onto target.ts", async () => {
    expect(externalFileCandidates("/tmp/notes ").map((c) => c.path)).toEqual([
      "/tmp/notes ",
      "/tmp/notes",
    ]);
    expect(normalizeExternalFilePath("file:///Users/me/CLAUDE.md:12:4")).toBe(
      "/Users/me/CLAUDE.md",
    );
    expect(normalizeExternalFilePath("/Users/me/CLAUDE.md#L10-L20")).toBe(
      "/Users/me/CLAUDE.md",
    );
    expect(normalizeExternalFilePath("/tmp/C#_notes.md:10")).toBe("/tmp/C#_notes.md");
    expect(normalizeExternalFilePath("file://localhost/tmp/My%20Notes.md")).toBe(
      "/tmp/My Notes.md",
    );
    expect(normalizeExternalFilePath("file:///tmp/My%20Notes.md#L3")).toBe(
      "/tmp/My Notes.md",
    );

    const disk = new Map<string, DiskStat>([
      ["/w/odd:2", { stamp: "1:5", size: 5, isFile: true, isDirectory: false }],
      ["/w/C#_notes.md", { stamp: "1:9", size: 9, isFile: true, isDirectory: false }],
      ["/w/sub", { stamp: "1:0", size: 0, isFile: false, isDirectory: true }],
    ]);
    const statted: string[] = [];
    const statFn = async (p: string) => {
      statted.push(p);
      return disk.get(p) ?? null;
    };

    expect(await resolveExternalFileReference("/w/odd:2", undefined, statFn)).toEqual({
      path: "/w/odd:2",
      line: 0,
      column: 0,
      isDirectory: false,
    });
    expect(statted).toEqual(["/w/odd:2"]);

    expect(await resolveExternalFileReference("/w/C#_notes.md:10:2", undefined, statFn)).toEqual({
      path: "/w/C#_notes.md",
      line: 10,
      column: 2,
      isDirectory: false,
    });

    expect(await resolveExternalFileReference("/w/sub", undefined, statFn)).toEqual({
      path: "/w/sub",
      line: 0,
      column: 0,
      isDirectory: true,
    });
    expect(await resolveExternalFileReference("https://example.com", undefined, statFn)).toBeNull();
  });

  test("derives allowsMode and canSaveFile strictly from VIEWER_SPECS", () => {
    const code = classifyFile("main.ts");
    const md = classifyFile("guide.md");
    const svg = classifyFile("icon.svg");
    const png = classifyFile("poster.png");
    const pdf = classifyFile("manual.pdf");
    const diff = classifyFile("fix.patch");

    expect(allowsMode(code, "source")).toBe(true);
    expect(allowsMode(code, "diff")).toBe(true);
    expect(allowsMode(code, "preview")).toBe(false);

    expect(allowsMode(md, "preview")).toBe(true);
    expect(allowsMode(md, "source")).toBe(true);
    expect(allowsMode(md, "diff")).toBe(true);

    expect(allowsMode(svg, "preview")).toBe(true);
    expect(allowsMode(svg, "source")).toBe(true);
    expect(allowsMode(png, "preview")).toBe(true);
    expect(allowsMode(png, "source")).toBe(false);
    expect(allowsMode(pdf, "diff")).toBe(false);
    expect(allowsMode(diff, "source")).toBe(true);

    expect(canSaveFile({ classification: code, readOnly: null })).toBe(true);
    expect(canSaveFile({ classification: svg, readOnly: null })).toBe(true);
    expect(canSaveFile({ classification: code, readOnly: "Not UTF-8" })).toBe(false);
    expect(canSaveFile({ classification: png, readOnly: null })).toBe(false);
    expect(canSaveFile({ classification: pdf, readOnly: null })).toBe(false);
  });
});

describe("L1.1 statDisk, single-spawn large-file head, and LRU prewarm cache", () => {
  test("cuts loadFile and loadTabFile to 1 statDisk call and spawns readHead ONCE on >8 MiB files", async () => {
    const bigTextBytes = new Uint8Array(MAX_PREVIEW_HEAD_BYTES);
    bigTextBytes.fill(65); // 'A'
    const bigBinBytes = new Uint8Array(MAX_PREVIEW_HEAD_BYTES);
    bigBinBytes[120] = 0; // NUL inside first 4 KiB

    const io = makeFakeIo({
      "/w": { kind: "dir" },
      "/w/small.ts": {
        kind: "file",
        bytes: new TextEncoder().encode("export const x = 1;\n"),
        mtimeMs: 500,
      },
      "/w/clip.mp4": {
        kind: "file",
        size: 50 * 1024 * 1024,
        mtimeMs: 600,
      },
      "/w/big.log": {
        kind: "file",
        bytes: bigTextBytes,
        size: MAX_EDITABLE_BYTES + 1024,
        mtimeMs: 700,
      },
      "/w/big.unk": {
        kind: "file",
        bytes: bigBinBytes,
        size: MAX_EDITABLE_BYTES + 2048,
        mtimeMs: 800,
      },
    });

    const d = await statDisk("/w/small.ts", io.deps);
    expect(d).toEqual({
      stamp: "500:20",
      size: 20,
      isFile: true,
      isDirectory: false,
    });
    expect(await statDisk("/w/missing.ts", io.deps)).toBeNull();

    // loadTabFile on an existing file runs 1 stat total (not 2-4).
    io.resetCounters();
    const loadedSmall = await loadTabFile("/w/small.ts", "/w", undefined, "M", io.deps);
    expect(io.statCalls).toBe(1);
    expect(loadedSmall.diskStamp).toBe("500:20");
    expect(loadedSmall.text).toBe("export const x = 1;\n");

    // Stat-only media kind (VIEWER_SPECS.video.io === "stat") runs 1 stat and 0 readFile calls.
    io.resetCounters();
    const loadedVideo = await loadFile("/w/clip.mp4", "/w", undefined, undefined, undefined, io.deps);
    expect(io.statCalls).toBe(1);
    expect(io.readFileCalls).toBe(0);
    expect(loadedVideo.size).toBe(50 * 1024 * 1024);

    // >8 MiB text file spawns readHead ONCE with MAX_PREVIEW_HEAD_BYTES (262,144).
    io.resetCounters();
    const loadedBigText = await loadFile("/w/big.log", "/w", undefined, undefined, undefined, io.deps);
    expect(io.statCalls).toBe(1);
    expect(io.headCalls).toEqual([{ path: "/w/big.log", count: MAX_PREVIEW_HEAD_BYTES }]);
    expect(loadedBigText.classification.kind).toBe("code");
    expect(loadedBigText.text.length).toBe(MAX_PREVIEW_HEAD_BYTES);
    expect(loadedBigText.readOnly).toContain("8 MB");

    // >8 MiB unknown binary file ALSO spawns readHead ONCE, detecting NUL in first 4 KiB in memory.
    io.resetCounters();
    const loadedBigBin = await loadFile("/w/big.unk", "/w", undefined, undefined, undefined, io.deps);
    expect(io.statCalls).toBe(1);
    expect(io.headCalls).toEqual([{ path: "/w/big.unk", count: MAX_PREVIEW_HEAD_BYTES }]);
    expect(loadedBigBin.classification.kind).toBe("binary");
    expect(loadedBigBin.hexDump).toContain("00000070");
  });

  test("warmWorkspaceFiles prewarms only code & markdown in a 32-entry LRU, clears on root change, and invalidates on withGitStatus", async () => {
    const files: Record<string, FakeFsEntry> = { "/w1": { kind: "dir" }, "/w2": { kind: "dir" } };
    const w1Entries: WorkspaceEntry[] = [
      { path: "/w1/pic.png", relPath: "pic.png", name: "pic.png", isDirectory: false },
      { path: "/w1/data.csv", relPath: "data.csv", name: "data.csv", isDirectory: false },
      { path: "/w1/doc.md", relPath: "doc.md", name: "doc.md", isDirectory: false },
    ];
    files["/w1/pic.png"] = { kind: "file", bytes: new Uint8Array([1, 2, 3]) };
    files["/w1/data.csv"] = { kind: "file", bytes: new TextEncoder().encode("a,b\n1,2\n") };
    files["/w1/doc.md"] = { kind: "file", bytes: new TextEncoder().encode("# Title\n") };

    for (let i = 0; i < 36; i += 1) {
      const p = `/w1/f${i}.ts`;
      files[p] = { kind: "file", bytes: new TextEncoder().encode(`const v = ${i};\n`) };
      w1Entries.push({ path: p, relPath: `f${i}.ts`, name: `f${i}.ts`, isDirectory: false });
    }
    files["/w2/other.ts"] = { kind: "file", bytes: new TextEncoder().encode("export {};\n") };

    const io = makeFakeIo(files);
    const snap1 = withGitStatus(
      { ...emptySnapshot(), root: "/w1", entries: w1Entries },
      {},
    );

    await warmWorkspaceFiles(snap1, io.deps);
    // Only code & markdown prewarm: pic.png and data.csv are skipped!
    expect(getPreloadedFile("/w1/pic.png", "/w1")).toBeNull();
    expect(getPreloadedFile("/w1/data.csv", "/w1")).toBeNull();
    expect(getPreloadedFile("/w1/doc.md", "/w1")?.text).toBe("# Title\n");
    // 1 stat per prewarmed candidate (12 max per warmWorkspaceFiles call).
    expect(io.statCalls).toBe(12);

    // Loading 35 distinct code files never freezes at 32 items: LRU evicts oldest cleanly.
    for (let i = 0; i < 35; i += 1) {
      await loadFile(`/w1/f${i}.ts`, "/w1", undefined, undefined, undefined, io.deps);
    }
    expect(getPreloadedFile("/w1/f34.ts", "/w1")?.text).toBe("const v = 34;\n");
    expect(getPreloadedFile("/w1/f0.ts", "/w1")).toBeNull();

    // withGitStatus invalidates entries whose gitStatus changed.
    const updatedSnap1 = withGitStatus(snap1, { "f34.ts": "M" });
    expect(updatedSnap1.gitStatusMap["f34.ts"]).toBe("M");
    expect(getPreloadedFile("/w1/f34.ts", "/w1")).toBeNull();
    // Unchanged entry stays warm.
    expect(getPreloadedFile("/w1/f33.ts", "/w1")).not.toBeNull();

    // Switching workspace root clears previous workspace entries.
    const snap2 = withGitStatus(
      {
        ...emptySnapshot(),
        root: "/w2",
        entries: [{ path: "/w2/other.ts", relPath: "other.ts", name: "other.ts", isDirectory: false }],
      },
      {},
    );
    await warmWorkspaceFiles(snap2, io.deps);
    expect(getPreloadedFile("/w1/f33.ts", "/w1")).toBeNull();
    expect(getPreloadedFile("/w2/other.ts", "/w2")?.text).toBe("export {};\n");
  });
});

describe("L1.1 Git lock safety, isGitRepo, bounded scanDirectory & O(K) detectRenames", () => {
  test("passes --no-optional-locks, sets isGitRepo accurately, avoids mutating entries, and bounds readdir concurrency <= 16", async () => {
    const tree: Record<string, FakeFsEntry> = { "/repo": { kind: "dir" } };
    for (let i = 0; i < 48; i += 1) {
      const sub = `/repo/pkg-${String(i).padStart(2, "0")}`;
      tree[sub] = { kind: "dir" };
      tree[`${sub}/index.ts`] = { kind: "file", bytes: new Uint8Array([1]) };
    }
    const io = makeFakeIo(tree);
    io.setReaddirDelay(4);
    io.setGitState({
      code: 0,
      status: " M pkg-00/index.ts\0?? pkg-01/index.ts\0",
      branch: "feat/clean\n",
    });

    const snap = await scanWorkspace("/repo", io.deps);
    expect(snap.isGitRepo).toBe(true);
    expect(snap.branch).toBe("feat/clean");
    expect(snap.flatFiles.length).toBe(48);
    expect(io.maxInFlightReaddir).toBeLessThanOrEqual(16);
    expect(io.maxInFlightReaddir).toBeGreaterThan(1);

    // Every git invocation carries --no-optional-locks before the subcommand.
    expect(io.gitCalls.length).toBeGreaterThanOrEqual(2);
    for (const args of io.gitCalls) {
      expect(args[0]).toBe("--no-optional-locks");
    }

    const directStatus = await readGitStatus("/repo", io.deps);
    expect(directStatus["pkg-00/index.ts"]).toBe("M");
    expect(directStatus["pkg-01/index.ts"]).toBe("U");

    // Non-Git folder (git exits 128) sets isGitRepo: false and empty branch/status.
    io.resetCounters();
    io.setGitState({ code: 128, status: "", branch: "" });
    const nonGit = await scanWorkspace("/repo", io.deps);
    expect(nonGit.isGitRepo).toBe(false);
    expect(nonGit.branch).toBe("");
    expect(nonGit.gitStatusMap).toEqual({});

    // withGitStatus never mutates previous snapshot.entries in place.
    const prevFirstChild = nonGit.entries[0]?.children?.[0];
    expect(prevFirstChild?.gitStatus).toBeUndefined();
    const withMod = withGitStatus(nonGit, { "pkg-00/index.ts": "M" });
    expect(prevFirstChild?.gitStatus).toBeUndefined();
    expect(withMod.entries[0]?.children?.[0]?.gitStatus).toBe("M");
  });

  test("detectRenames finds 1-to-1 same-kind renames in O(K) and ignores ambiguous multi-changes", () => {
    const before: WorkspaceEntry[] = [
      { path: "/w/a.ts", relPath: "a.ts", name: "a.ts", isDirectory: false },
      {
        path: "/w/sub",
        relPath: "sub",
        name: "sub",
        isDirectory: true,
        children: [{ path: "/w/sub/old.md", relPath: "sub/old.md", name: "old.md", isDirectory: false }],
      },
    ];
    const after: WorkspaceEntry[] = [
      { path: "/w/a-renamed.ts", relPath: "a-renamed.ts", name: "a-renamed.ts", isDirectory: false },
      {
        path: "/w/sub",
        relPath: "sub",
        name: "sub",
        isDirectory: true,
        children: [{ path: "/w/sub/new.md", relPath: "sub/new.md", name: "new.md", isDirectory: false }],
      },
    ];
    expect(detectRenames("/w", before, after)).toEqual([
      ["/w/a.ts", "/w/a-renamed.ts"],
      ["/w/sub/old.md", "/w/sub/new.md"],
    ]);

    // File replaced by directory of new name is NOT treated as a file rename.
    const kindChanged: WorkspaceEntry[] = [
      { path: "/w/a-dir", relPath: "a-dir", name: "a-dir", isDirectory: true, children: [] },
      after[1],
    ];
    expect(detectRenames("/w", before, kindChanged)).toEqual([["/w/sub/old.md", "/w/sub/new.md"]]);
  });
});

describe("L1.1 async/effect primitives & window state file sync", () => {
  test("onceAsync deduplicates concurrent calls, memoizes success, and allows retry after failure", async () => {
    let calls = 0;
    let shouldFail = true;
    const probe = onceAsync(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (shouldFail) throw new Error("transient");
      return { shells: ["zsh"], run: calls };
    });

    await expect(probe()).rejects.toThrow("transient");
    expect(calls).toBe(1);

    shouldFail = false;
    const [r1, r2] = await Promise.all([probe(), probe()]);
    expect(calls).toBe(2);
    expect(r1).toEqual({ shells: ["zsh"], run: 2 });
    expect(r2).toBe(r1);
    expect(await probe()).toBe(r1);
    expect(calls).toBe(2);
  });

  test("nextPollDelayMs & watchActiveInterval implement 2000->5000->10000 backoff, pause in background, and run on resume", async () => {
    expect(nextPollDelayMs(2000, 2000, 10000, "idle")).toBe(5000);
    expect(nextPollDelayMs(5000, 2000, 10000, "idle")).toBe(10000);
    expect(nextPollDelayMs(10000, 2000, 10000, "idle")).toBe(10000);
    expect(nextPollDelayMs(10000, 2000, 10000, "changed")).toBe(2000);

    const life = signal("active");
    const enabled = signal(true);
    let ticks = 0;
    let resumes = 0;
    let deferredRan = 0;
    const gate = signal(0);

    effect(() => {
      const g = gate();
      deferOutOfEffect(() => {
        deferredRan = g + 1;
      });
    });
    // Immediate re-run before 0ms timer cancels the stale first deferred callback.
    gate.set(10);
    await new Promise((r) => setTimeout(r, 15));
    expect(deferredRan).toBe(11);

    watchActiveInterval({
      baseMs: 12,
      maxMs: 60,
      lifecycle: life,
      enabled,
      onResume: () => {
        resumes += 1;
      },
      tick: async () => {
        ticks += 1;
        return false;
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBeGreaterThanOrEqual(1);

    // Pause in background: zero ticks while inactive.
    life.set("background");
    const ticksAtPause = ticks;
    await new Promise((r) => setTimeout(r, 35));
    expect(ticks).toBe(ticksAtPause);

    // Resume to active: runs immediately and calls onResume.
    life.set("active");
    await new Promise((r) => setTimeout(r, 10));
    expect(resumes).toBe(1);
    expect(ticks).toBeGreaterThan(ticksAtPause);

    // Disable stops polling cleanly.
    enabled.set(false);
    const ticksAtDisable = ticks;
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toBe(ticksAtDisable);
  });

  test("syncWindowStateFile writes home, loose, and workspace state atomically into active queue dir", async () => {
    const cacheDir = "/Users/test/Library/Caches/dev.byronwayne.aed";
    const queueDir = `${cacheDir}/open-4242`;
    const io = makeFakeIo({
      [cacheDir]: { kind: "dir" },
      [queueDir]: { kind: "dir" },
    });

    await syncWindowStateFile("home", "", { queueDir, cacheDir, deps: io.deps });
    expect(new TextDecoder().decode(io.entries.get(`${queueDir}/state`)?.bytes)).toBe("home\n");

    await syncWindowStateFile("loose", "", { queueDir, cacheDir, deps: io.deps });
    expect(new TextDecoder().decode(io.entries.get(`${queueDir}/state`)?.bytes)).toBe("loose\n");

    await syncWindowStateFile("workspace", "/Users/test/proj", { queueDir, cacheDir, deps: io.deps });
    expect(new TextDecoder().decode(io.entries.get(`${queueDir}/state`)?.bytes)).toBe(
      "workspace\n/Users/test/proj\n",
    );

    // Rejects queue paths outside Aed's cache dir.
    await syncWindowStateFile("home", "", {
      queueDir: "/tmp/open-4242",
      cacheDir,
      deps: io.deps,
    });
    expect(io.entries.has("/tmp/open-4242/state")).toBe(false);
  });
});
