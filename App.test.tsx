import { describe, expect, open, test } from "nsh/test";
import {
  classifyFile,
  formatHexDump,
  normalizeMachOBuildVersion,
  parseTableData,
  probeImageDimensions,
} from "./src/classify";
import {
  detectMermaidKind,
  preprocessMermaidCode,
  planJobTimeout,
  requeueOrphanedJobs,
  takeJob,
} from "./src/mermaid";
import {
  decideGuard,
  deriveEditorSurface,
  deriveWindowMode,
  externalOpenKeepsTree,
  type ExternalOrigin,
  nextActiveAfterClose,
  planWorkspaceIntent,
  serialize,
  WINDOW_TRANSITIONS,
  type WindowEvent,
  type WindowMode,
} from "./src/session";
import { createInputGate, parseGhosttyConfig, shouldFollowCwd } from "./src/TerminalPane";
import manifest from "./nsh.json";
import {
  computeSyntaxDecorations,
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  fontDisplayName,
  getThemeById,
} from "./src/themes";
import { isBehindDisk, normalizeExternalFilePath, shortenHomePath } from "./src/workspace";

const FIXTURE_ROOT = "/Users/byronwayne/Projects/sides/native-editor/fixtures";

describe("classify, multimedia probes & Ghostty config verification", () => {
  test("classifies markdown, code, table, diff, image, video, audio, quicklook, and binary files", () => {
    expect(classifyFile("README.md").kind).toBe("markdown");
    expect(classifyFile("architecture.mmd").kind).toBe("mermaid");
    expect(classifyFile("diagram.mermaid").kind).toBe("mermaid");
    expect(classifyFile("index.tsx").kind).toBe("code");
    expect(classifyFile("index.tsx").language).toBe("tsx");
    expect(classifyFile("Dockerfile").language).toBe("dockerfile");
    expect(classifyFile("data.csv").kind).toBe("table");
    expect(classifyFile("data.tsv").kind).toBe("table");
    expect(classifyFile("data.jsonl").kind).toBe("table");
    expect(classifyFile("fix.patch").kind).toBe("diff");
    expect(classifyFile("photo.png").kind).toBe("image");
    expect(classifyFile("photo.webp").kind).toBe("image");
    expect(classifyFile("photo.avif").kind).toBe("image");
    expect(classifyFile("vector.svg").language).toBe("xml");
    expect(classifyFile("clip.mp4").kind).toBe("video");
    expect(classifyFile("movie.mov").kind).toBe("video");
    expect(classifyFile("tone.wav").kind).toBe("audio");
    expect(classifyFile("song.mp3").kind).toBe("audio");
    expect(classifyFile("track.flac").kind).toBe("audio");
    expect(classifyFile("report.pdf").kind).toBe("quicklook");

    const binBytes = new Uint8Array([0x89, 0x00, 0x48, 0x65]);
    expect(classifyFile("unknown.dat", binBytes).kind).toBe("binary");
  });

  test("probes PNG and SVG dimensions and parses Ghostty config", () => {
    const svgDim = probeImageDimensions(
      new Uint8Array(0),
      '<svg viewBox="0 0 320 180"></svg>'
    );
    expect(svgDim).toEqual({ width: 320, height: 180 });

    const cfg = parseGhosttyConfig(
      'theme = Kanagawa Dragon\nfont-family = JetBrainsMono Nerd Font Mono\nfont-size = 13.5\n'
    );
    expect(cfg.theme).toBe("Kanagawa Dragon");
    expect(cfg.fontFamily).toBe("JetBrainsMono Nerd Font Mono");
    expect(cfg.fontSize).toBe(13.5);

    expect(detectMermaidKind("%% comment\nflowchart TB\nA-->B")).toBe("flowchart TB");
    expect(detectMermaidKind("sequenceDiagram\nA->>B: hi")).toBe("sequenceDiagram");
    expect(
      preprocessMermaidCode('flowchart TB\n  A["line1\n    line2"]')
    ).toBe('flowchart TB\n  A["line1<br/>line2"]');
  });

  test("parses CSV, TSV, and JSONL into DataTable columns and rows", () => {
    const csv = parseTableData(
      'name,score,note\nAlice,95,"fast, ""clean"" path"\nBob,88,plain\n',
      "scores.csv"
    );
    expect(csv.columns).toHaveLength(3);
    expect(csv.columns[0].title).toBe("name");
    expect(csv.rows).toEqual([
      ["Alice", 95, 'fast, "clean" path'],
      ["Bob", 88, "plain"],
    ]);

    const jsonl = parseTableData(
      '{"host":"node-1","cpu":42}\n{"host":"node-2","cpu":19}\n',
      "nodes.jsonl"
    );
    expect(jsonl.columns.map((c) => c.title)).toEqual(["host", "cpu"]);
    expect(jsonl.rows).toEqual([
      ["node-1", 42],
      ["node-2", 19],
    ]);
  });

  test("formats binary bytes as hex + ASCII dump and computes syntax decorations across themes", () => {
    const dump = formatHexDump(new Uint8Array([0x48, 0x69, 0x00, 0x21]));
    expect(dump).toContain("00000000");
    expect(dump).toContain("48 69 00 21");
    expect(dump).toContain("|Hi.!|");

    expect(EDITOR_THEMES.length).toBeGreaterThanOrEqual(6);
    const tokyo = getThemeById("tokyo-night");
    expect(tokyo.name).toBe("Tokyo Night");
    expect(classifyFile("subtitles.srt").language).toBe("srt");
    expect(classifyFile(".prettierrc").language).toBe("json");

    const jsonDecos = computeSyntaxDecorations(
      '{\n  "schema_version": "v1",\n  "duration": 50.27,\n  "active": true\n}',
      "json",
      tokyo.syntax
    );
    expect(jsonDecos.length).toBeGreaterThanOrEqual(4);

    const tsSource =
      'export function greet(name: string): string {\n  // hello\n  return "hi";\n}';
    const tsDecos = computeSyntaxDecorations(
      tsSource,
      "typescript",
      tokyo.syntax
    );
    expect(tsDecos.length).toBeGreaterThanOrEqual(5);
    expect(
      computeSyntaxDecorations(tsSource, "typescript", tokyo.syntax)
    ).toBe(tsDecos);
  });

  test("shortens home paths and names fonts without Nerd Font suffixes", () => {
    expect(shortenHomePath("/Users/me/Projects/x", "/Users/me")).toBe("~/Projects/x");
    expect(shortenHomePath("/Users/me", "/Users/me")).toBe("~");
    expect(shortenHomePath("/Users/meow/x", "/Users/me")).toBe("/Users/meow/x");
    expect(shortenHomePath("/tmp/x", "")).toBe("/tmp/x");
    expect(fontDisplayName("JetBrainsMono Nerd Font Mono")).toBe("JetBrainsMono");
    expect(fontDisplayName("SF Mono")).toBe("SF Mono");
    expect(fontDisplayName("Fira Code")).toBe("Fira Code");
    expect(fontDisplayName("")).toBe("Mono");
  });

  test("static nsh.json tokens match the default Industrial themes (no black/white split)", () => {
    const paper = getThemeById(DEFAULT_THEME_ID);
    const carbon = getThemeById("industrial-carbon");
    const vars = manifest.theme.cssVars;
    expect(paper.id).toBe("industrial-paper");
    expect(vars.light.background).toBe(paper.ui.background);
    expect(vars.light.foreground).toBe(paper.ui.foreground);
    expect(vars.light.primary).toBe(paper.ui.accent);
    expect(vars.dark.background).toBe(carbon.ui.background);
    expect(vars.dark.foreground).toBe(carbon.ui.foreground);
    expect(vars.dark.primary).toBe(carbon.ui.accent);
  });

  test("enforces least-privilege process.execute allowlist and Aed bundle identity in nsh.json", () => {
    expect(manifest.name).toBe("Aed");
    expect(manifest.id).toBe("dev.byronwayne.aed");
    expect(manifest.capabilities.process.execute).toEqual([
      "git",
      "python3",
      "sips",
      "osascript",
    ]);
    expect(manifest.capabilities.process.env).toContain("AED_ROOT");
    expect(manifest.capabilities.process.env).toContain("AED_OPEN_FILE");
  });

  test("normalizes Mach-O LC_BUILD_VERSION minos/sdk to macOS 11.0 / 14.0 to prevent LaunchServices -10825 error", () => {
    // 32-byte Mach-O 64 header (magic=0xfeedfacf, ncmds=1) + 24-byte LC_BUILD_VERSION (cmd=0x32, minos=27.0.0, sdk=27.0.0)
    const macho = new Uint8Array(56);
    const view = new DataView(macho.buffer);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(16, 1, true);
    view.setUint32(32, 0x32, true);
    view.setUint32(36, 24, true);
    view.setUint32(40, 1, true); // PLATFORM_MACOS
    view.setUint32(44, 0x001b0000, true); // minos 27.0.0
    view.setUint32(48, 0x001b0000, true); // sdk 27.0.0

    const first = normalizeMachOBuildVersion(macho);
    expect(first).toEqual({
      minos: 0x000b0000,
      sdk: 0x000e0000,
      patched: true,
    });
    expect(view.getUint32(44, true)).toBe(0x000b0000);
    expect(view.getUint32(48, true)).toBe(0x000e0000);

    const second = normalizeMachOBuildVersion(macho);
    expect(second).toEqual({
      minos: 0x000b0000,
      sdk: 0x000e0000,
      patched: false,
    });
    expect(normalizeMachOBuildVersion(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

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
    expect(planWorkspaceIntent("/w/cur", 2, { kind: "open", root: "/w/cur/" })).toEqual({ action: "refresh" });
    expect(planWorkspaceIntent("/w/cur", 2, { kind: "open", root: "/" })).toEqual({ action: "ignore" });
    expect(planWorkspaceIntent("", 0, { kind: "close" })).toEqual({ action: "ignore" });
    expect(planWorkspaceIntent("", 1, { kind: "close" })).toEqual({ action: "reset", nextRoot: "" });
    expect(externalOpenKeepsTree("drop")).toBe(true);
    expect(externalOpenKeepsTree("click")).toBe(false);

    expect(deriveEditorSurface("", false)).toBe("welcome");
    expect(deriveEditorSurface("/w", false)).toBe("workspace-empty");
    expect(deriveEditorSurface("", true)).toBe("file");

    const pending = { dirtyPaths: ["/w/a.ts"], onProceed: () => {} };
    expect(decideGuard(null, [])).toBe("run");
    expect(decideGuard(null, ["/w/a.ts"])).toBe("confirm");
    expect(decideGuard(pending, [])).toBe("busy");

    expect(nextActiveAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(nextActiveAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
    expect(nextActiveAfterClose(["a", "b"], "a", "b")).toBe("b");
    expect(nextActiveAfterClose(["a", "b"], "b", "b")).toBe("a");
    expect(nextActiveAfterClose(["a"], "a", "a")).toBeNull();
  });

  test("Mermaid jobs orphaned by an unmounted WebView go back to the front of the queue", () => {
    const active = new Map([[1, "job-1"], [2, "job-2"]]);
    const pending = ["job-3"];
    requeueOrphanedJobs(active, pending);
    expect(pending).toEqual(["job-1", "job-2", "job-3"]);
    expect(active.size).toBe(0);
  });

  test("a timed-out Mermaid job leaves whichever queue holds it, once", () => {
    const active = new Map([[1, { id: 1 }]]);
    const pending = [{ id: 2 }, { id: 3 }];
    expect(takeJob(1, active, pending)).toEqual({ id: 1 });
    expect(active.size).toBe(0);
    expect(takeJob(3, active, pending)).toEqual({ id: 3 });
    expect(pending).toEqual([{ id: 2 }]);
    expect(takeJob(3, active, pending)).toBeUndefined();
    expect(takeJob(9, active, pending)).toBeUndefined();
    expect(pending).toEqual([{ id: 2 }]);
    expect(takeJob(2, active, pending)).toEqual({ id: 2 });
    expect(pending).toEqual([]);
  });

  test("a Mermaid timeout drops only the worker its job waited on", () => {
    // A: the current worker (ready or not) never answered: drop it.
    const active = new Map([[1, { id: 1, generation: 3 }]]);
    expect(planJobTimeout(1, active, [], 3)).toEqual({ job: { id: 1, generation: 3 }, dropWorker: true });
    // B: an older job's timeout must not kill the newer worker that is still starting.
    const pending = [{ id: 2, generation: 3 }];
    expect(planJobTimeout(2, new Map(), pending, 4)).toEqual({ job: { id: 2, generation: 3 }, dropWorker: false });
    // Already settled: nothing to fail, nothing to drop.
    expect(planJobTimeout(2, new Map(), pending, 4)).toEqual({ job: undefined, dropWorker: false });
  });

  test("a copy is behind the disk only when both stamps are known and differ", () => {
    expect(isBehindDisk("1:5", "1:5")).toBe(false);
    expect(isBehindDisk("1:5", "2:5")).toBe(true);
    expect(isBehindDisk(null, "2:5")).toBe(false);
    expect(isBehindDisk("1:5", null)).toBe(false);
  });

  test("terminal input waits until the shell has drawn its prompt", () => {
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const gate = createInputGate(
      (text) => written.push(text),
      (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      (t) => {
        if (t) (t as { live: boolean }).live = false;
      }
    );
    const fireLast = () => {
      const t = timers[timers.length - 1];
      if (t.live) t.fn();
    };
    const fallback = timers[0]; // SHELL_READY_MAX_MS, set when the gate is made
    expect(fallback.ms).toBe(3000);
    gate.send("echo early\n");
    expect(written).toEqual([]); // the shell has printed nothing yet
    gate.output();
    gate.output(); // more startup output restarts the quiet wait
    expect(timers.filter((t) => t.live).length).toBe(2);
    expect(written).toEqual([]);
    fireLast(); // quiet after output: the prompt is drawn
    expect(written).toEqual(["echo early\n"]);
    gate.send("echo late\n");
    expect(written).toEqual(["echo early\n", "echo late\n"]);
    expect(fallback.live).toBe(false); // opened: the fallback is cancelled
    // A shell that prints nothing still gets its input after SHELL_READY_MAX_MS.
    const silentWritten: string[] = [];
    const silentTimers: Array<() => void> = [];
    const silent = createInputGate(
      (text) => silentWritten.push(text),
      (fn) => silentTimers.push(fn),
      () => undefined
    );
    silent.send("echo quiet\n");
    expect(silentWritten).toEqual([]);
    silentTimers[0]();
    expect(silentWritten).toEqual(["echo quiet\n"]);
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

  test("only a terminal the user has not typed into follows the open folder", () => {
    expect(shouldFollowCwd({ cwd: "/home", used: false }, "/w/cur", "ls -la")).toBe(false);
    expect(shouldFollowCwd({ cwd: "/home", used: false }, "/w/cur", "  ")).toBe(true);
    expect(shouldFollowCwd({ cwd: "/home", used: false }, "/w/cur")).toBe(true);
    expect(shouldFollowCwd({ cwd: "/home", used: true }, "/w/cur")).toBe(false);
    expect(shouldFollowCwd({ cwd: "/w/cur", used: false }, "/w/cur")).toBe(false);
    expect(shouldFollowCwd(undefined, "/w/cur")).toBe(false);
  });
});

type TestApp = Awaited<ReturnType<typeof open>>;

/**
 * Scratch folders for disk-change tests (the test sandbox cannot write files, so the
 * app's own PTY does). One folder per test and run, removed when the test ends.
 */
const SCRATCH_RUN = `/tmp/aed-e2e-disk-${Date.now().toString(36)}`;
let scratchCount = 0;

async function runInTerminal(app: TestApp, cmd: string, marker: string): Promise<void> {
  if (!app.shows("id:terminal-pane")) {
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
  }
  await app.type("id:terminal-input", `${cmd} && echo ${marker}`);
  await app.submit("id:terminal-input");
  await app.waitUntil(
    () => app.texts().some((t) => t.includes(marker) && !t.includes("echo")),
    { timeout: 8000 }
  );
}

const showsText = (app: TestApp, text: string) => app.texts().some((t) => t === text);

/** Longer than one disk check (DISK_CHECK_MS = 1500), so a wrong banner would have appeared. */
const pastOneDiskCheck = () => new Promise((resolve) => setTimeout(resolve, 2000));

interface Scratch {
  app: TestApp;
  dir: string;
  write: (name: string, content: string) => Promise<void>;
}

/**
 * Run `body` in a window on a fresh scratch folder holding `files` (name → one line),
 * with `files`' first name open. The folder is removed afterwards, also on failure.
 */
async function withScratch(files: Record<string, string>, body: (s: Scratch) => Promise<void>) {
  scratchCount += 1;
  const dir = `${SCRATCH_RUN}-${scratchCount}`;
  const writes = Object.entries(files).map(([n, c]) => `printf '${c}\\n' > ${dir}/${n}`);
  const setup = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
  await runInTerminal(setup, [`rm -rf ${dir}`, `mkdir -p ${dir}`, ...writes].join(" && "), "SETUP_DONE");
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 800,
    host: { params: { workspaceRoot: dir } },
  });
  let step = 0;
  const write = (name: string, content: string) =>
    runInTerminal(app, `printf '${content}\\n' > ${dir}/${name}`, `WRITE_DONE_${(step += 1)}`);
  try {
    const [first, content] = Object.entries(files)[0];
    await app.waitFor(`text:${first}`);
    await app.press(`text:${first}`);
    await app.waitUntil(() => showsText(app, content), { timeout: 5000 });
    await body({ app, dir, write });
  } finally {
    await runInTerminal(setup, `rm -rf ${dir}`, "CLEAN_DONE");
  }
}

/** Make the open tab dirty by typing `text`, and wait for its unsaved dot. */
async function editTab(app: TestApp, text: string): Promise<void> {
  await app.type("id:preview-editor", text);
  await app.waitUntil(() => showsText(app, "•"), { timeout: 3000 });
}

describe("Aed E2E desktop UI, multimedia preview & Ghostty terminal", () => {
  test("clean launch without workspace hides file tree, shows Aed welcome panel, and migrates legacy storage", async () => {
    const cleanApp = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "native-editor.theme": "tokyo-night",
      },
    });
    await cleanApp.waitFor("id:welcome-panel");
    expect(cleanApp.shows("id:welcome-panel")).toBe(true);
    expect(cleanApp.shows("text:Aed")).toBe(true);
    expect(cleanApp.shows("text:Open Folder")).toBe(false);
    expect(cleanApp.shows("id:welcome-open-folder")).toBe(false);
    expect(cleanApp.shows("text:⌘O")).toBe(false);
    expect(cleanApp.spanStyle("text:Aed").color).toBe("#c0caf5ff");
    expect(cleanApp.shows("id:workspace-tree")).toBe(false);
    expect(cleanApp.shows("id:theme-preset-tokyo-night")).toBe(false);
    expect(cleanApp.shows("id:sidebar-refresh")).toBe(false);
    expect(cleanApp.shows("id:statusbar-theme-trigger")).toBe(false);
    expect(cleanApp.shows("id:statusbar-font-trigger")).toBe(false);
    expect(cleanApp.shows("id:titlebar-toggle-theme")).toBe(false);
    expect(cleanApp.shows("text:main")).toBe(false);

    // Shrinking viewport below minimum window dimensions must not crush the poster grid
    await cleanApp.setViewport(280, 450);
    expect(cleanApp.spanStyle("text:Aed").fontSize).toBeGreaterThanOrEqual(56);

    // Subsequent launches with saved recentWorkspaces must stay on WelcomePanel poster
    // (listing recent workspaces for 1-click access) instead of forcibly opening the old folder.
    const returningApp = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "aed.recentWorkspaces": JSON.stringify([FIXTURE_ROOT]),
      },
    });
    await returningApp.waitFor("id:welcome-recent-fixtures");
    expect(returningApp.shows("id:welcome-panel")).toBe(true);
    expect(returningApp.shows("id:empty-editor-panel")).toBe(false);
    expect(returningApp.shows("id:workspace-tree")).toBe(false);
    await returningApp.press("id:welcome-recent-fixtures");
    await returningApp.waitFor("id:empty-editor-panel");
    expect(returningApp.shows("id:workspace-tree")).toBe(true);
  });

  test("renders multi-format & multimedia previews, switches modes, searches files, and runs PTY commands", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: {
        params: {
          workspaceRoot: FIXTURE_ROOT,
        },
      },
    });

    await app.waitFor("text:README.md");
    expect(app.shows("id:main-dock")).toBe(true);
    expect(app.shows("id:workspace-tree")).toBe(true);
    expect(app.shows("id:welcome-panel")).toBe(false);
    expect(app.shows("id:empty-editor-panel")).toBe(true);
    expect(app.shows("text:FIXTURES")).toBe(false);

    // 1. Markdown preview + Markdown raw source switch
    await app.press("text:README.md");
    await app.waitFor("id:preview-markdown");
    expect(app.shows("id:preview-markdown")).toBe(true);
    expect(app.shows("id:mode-preview")).toBe(true);
    expect(app.shows("id:mode-source")).toBe(true);

    await app.press("id:mode-source");
    await app.waitFor("id:preview-editor");
    expect(app.shows("id:preview-editor")).toBe(true);

    await app.press("id:mode-preview");
    await app.waitFor("id:preview-markdown");

    // 2. CSV Table preview + Code switch
    await app.press("text:metrics.csv");
    await app.waitFor("id:preview-table");
    expect(app.shows("id:preview-table")).toBe(true);
    await app.press("id:mode-source");
    await app.waitFor("id:preview-editor");
    await app.press("id:mode-preview");
    await app.waitFor("id:preview-table");

    // 3. Diff patch preview + Split/Unified toggle
    await app.press("text:changes.diff");
    await app.waitFor("id:preview-diff");
    expect(app.shows("id:preview-diff")).toBe(true);
    await app.press("id:diff-layout-toggle");
    await app.waitFor("text:Split View");

    // 4. Code editor preview (no redundant mode pills on normal code files)
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    expect(app.shows("id:preview-editor")).toBe(true);
    expect(app.shows("id:mode-preview")).toBe(false);
    expect(app.shows("id:mode-source")).toBe(false);
    expect(app.shows("id:mode-diff")).toBe(false);

    // 5. Multimedia: SVG & Raster PNG Image preview + zoom/backdrop controls
    await app.press("text:icon.svg");
    await app.waitFor("id:preview-image");
    expect(app.shows("id:preview-image")).toBe(true);
    await app.press("id:mode-source");
    await app.waitFor("id:preview-editor");

    await app.press("text:poster.png");
    await app.waitFor("id:preview-image");
    expect(app.shows("id:preview-image")).toBe(true);
    await app.keyboard.press("mod+f");
    expect(app.shows("id:editor-find-input")).toBe(false);
    await app.press("id:image-zoom-in");
    expect(app.shows("text:125%")).toBe(true);
    await app.press("id:image-zoom-reset");
    expect(app.shows("text:100%")).toBe(true);
    await app.press("id:image-bg-toggle");

    // 6. Multimedia: MP4 Video preview
    await app.press("text:clip.mp4");
    await app.waitFor("id:preview-video");
    expect(app.shows("id:preview-video")).toBe(true);

    // 7. Multimedia: WAV Audio preview
    await app.press("text:tone.wav");
    await app.waitFor("id:preview-audio");
    expect(app.shows("id:preview-audio")).toBe(true);

    // 8. Multimedia: PDF Quick Look preview (paper sheet + zoom controls)
    await app.press("text:manual.pdf");
    await app.waitFor("id:preview-quicklook");
    expect(app.shows("id:preview-quicklook")).toBe(true);
    expect(app.shows("id:preview-quicklook-sheet")).toBe(true);
    await app.press("id:quicklook-zoom-in");
    expect(app.shows("text:125%")).toBe(true);
    await app.press("id:quicklook-zoom-reset");
    expect(app.shows("text:100%")).toBe(true);

    // 9. Binary Hex dump preview (mode pills hidden)
    await app.press("text:sample.bin");
    await app.waitFor("id:preview-hex");
    expect(app.shows("id:preview-hex")).toBe(true);
    expect(app.shows("id:mode-source")).toBe(false);

    // 10. Tab switching and tab close button (×)
    await app.press("id:tab-select-README.md");
    await app.waitFor("id:preview-markdown");
    await app.press("id:tab-close-README.md");
    expect(app.shows("id:tab-select-README.md")).toBe(false);
    await app.waitFor("id:preview-hex");

    // 11. Sidebar toggle & Changed filter toggle
    await app.press("id:sidebar-filter-changed");
    await app.press("id:sidebar-filter-all");
    await app.press("id:titlebar-toggle-sidebar");
    expect(app.shows("id:workspace-tree")).toBe(false);
    await app.press("id:titlebar-toggle-sidebar");
    await app.waitFor("id:workspace-tree");

    // 12. Read-only StatusBar (no mystery refresh or accidental theme/font buttons) & Preferences dialog (mod+,)
    expect(app.shows("id:status-bar")).toBe(true);
    expect(app.shows("id:sidebar-refresh")).toBe(false);
    expect(app.shows("id:statusbar-theme-trigger")).toBe(false);
    expect(app.shows("id:statusbar-font-trigger")).toBe(false);
    expect(app.shows("id:titlebar-toggle-theme")).toBe(false);

    await app.keyboard.press("mod+,");
    await app.waitFor("id:font-settings-dialog");
    expect(app.shows("id:theme-preset-tokyo-night")).toBe(true);
    await app.press("id:theme-preset-tokyo-night");
    await app.press("id:font-preset-Menlo");
    await app.press("id:font-size-inc");
    expect(app.shows("text:15px")).toBe(true);
    await app.press("id:font-reset-btn");
    expect(app.shows("text:13px")).toBe(true);
    await app.press("id:font-dialog-close");

    // 13. Quick Open + Markdown Mermaid diagram block & standalone .mmd preview + Copy
    expect(app.shows("text:fixtures")).toBe(true);
    await app.press("id:titlebar-quick-open");
    await app.waitFor("id:command-palette");
    await app.type("id:command-palette", "guide.md");
    await app.keyboard.press("enter");
    await app.waitFor("id:preview-markdown");
    await app.waitFor("id:mermaid-block >> nth=0");
    expect(app.shows("id:mermaid-block >> nth=0")).toBe(true);
    expect(app.shows("text:MERMAID")).toBe(false);
    await app.press("id:mermaid-copy-code >> nth=0");
    await app.press("id:mermaid-toggle-code >> nth=0");
    await app.waitFor("id:mermaid-code-view");
    await app.press("id:mermaid-toggle-code >> nth=0");

    await app.press("text:architecture.mmd");
    await app.waitFor("id:preview-mermaid");
    expect(app.shows("id:preview-mermaid")).toBe(true);
    await app.press("id:mode-source");
    await app.waitFor("id:preview-editor");
    await app.keyboard.press("mod+f");
    await app.waitFor("id:editor-find-input");
    await app.type("id:editor-find-input", "flowchart");
    await app.keyboard.press("mod+f");
    await app.press("id:mode-preview");
    await app.waitFor("id:preview-mermaid");

    // 14. Dynamic Terminal (resizable pane + shell dropdown selector, no external button)
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    expect(app.shows("id:terminal-shell-select")).toBe(true);
    expect(app.shows("id:terminal-external-btn")).toBe(false);
    await app.type("id:terminal-input", "echo NSH_PTY_OK_2026");
    await app.keyboard.press("enter");
    await app.waitUntil(
      () => app.texts().some((t) => t.includes("NSH_PTY_OK_2026")),
      { timeout: 8000 }
    );
    await app.press("id:terminal-add-btn");
  });

  test("supports returning to welcome page, static sidebar title, dirty-tab guard, and loose external file without hijacking workspace", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: {
        params: {
          workspaceRoot: FIXTURE_ROOT,
        },
      },
    });

    await app.waitFor("id:sidebar-workspace-title");
    expect(app.shows("id:sidebar-workspace-title")).toBe(true);
    expect(app.shows("id:sidebar-close-folder")).toBe(true);
    expect(app.shows("id:empty-editor-close-folder")).toBe(true);

    // Dirty file protection when closing a modified tab
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    await app.type("id:preview-editor", "// unsaved edit\n");
    await app.press("id:tab-close-main.ts");
    await app.waitFor("id:unsaved-changes-dialog");
    expect(app.shows("id:unsaved-changes-dialog")).toBe(true);

    // Cancel keeps dirty tab open
    await app.press("id:unsaved-cancel-btn");
    expect(app.shows("id:unsaved-changes-dialog")).toBe(false);
    expect(app.shows("id:tab-select-main.ts")).toBe(true);

    // Discard closes tab and evicts dirty state from memory; re-clicking the same tree item reopens clean file
    await app.press("id:tab-close-main.ts");
    await app.waitFor("id:unsaved-discard-btn");
    await app.press("id:unsaved-discard-btn");
    expect(app.shows("id:tab-select-main.ts")).toBe(false);

    await app.press("text:main.ts");
    await app.waitFor("id:tab-select-main.ts");
    expect(app.shows("id:tab-select-main.ts")).toBe(true);
    expect(app.shows("text:•")).toBe(false);

    // Dropping the already-open workspace directory refreshes without wiping open tabs
    await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}`]);
    expect(app.shows("id:tab-select-main.ts")).toBe(true);

    // Close Folder returns to WelcomePanel poster and hides file tree
    await app.press("id:sidebar-close-folder");
    await app.waitFor("id:welcome-panel");
    expect(app.shows("id:welcome-panel")).toBe(true);
    expect(app.shows("id:workspace-tree")).toBe(false);

    // Pressing mod+b on welcome screen must not hide sidebar when reopening recent workspace
    await app.keyboard.press("mod+b");
    await app.press("id:titlebar-quick-open");
    await app.waitFor("id:command-palette");
    await app.keyboard.press("escape");

    await app.press("id:welcome-recent-fixtures");
    await app.waitFor("id:workspace-tree");
    expect(app.shows("id:workspace-tree")).toBe(true);
    expect(app.shows("id:empty-editor-panel")).toBe(true);

    // Clicking an external file (queued via /tmp/aed-open.queue) after workspace transitions
    // must open the file tab instead of staying stuck on EmptyEditorPanel.
    expect(
      normalizeExternalFilePath("file:///Users/byronwayne/Projects/sides/native-editor/CLAUDE.md:12:4")
    ).toBe("/Users/byronwayne/Projects/sides/native-editor/CLAUDE.md");
    expect(
      normalizeExternalFilePath("/Users/byronwayne/Projects/sides/native-editor/CLAUDE.md#L10-L20")
    ).toBe("/Users/byronwayne/Projects/sides/native-editor/CLAUDE.md");
    expect(
      normalizeExternalFilePath("/Users/byronwayne/Projects/C#_notes.md:10")
    ).toBe("/Users/byronwayne/Projects/C#_notes.md");
    await app.host.send("enqueueFinderOpen", `${FIXTURE_ROOT}/README.md:1:1`);
    await app.waitFor("id:preview-markdown", { timeout: 1500 });
    expect(app.shows("id:preview-markdown")).toBe(true);
    expect(app.shows("id:empty-editor-panel")).toBe(false);
    expect(app.shows("id:workspace-tree")).toBe(false);

    // Loose external file launch does not hijack workspaceRoot or prevent returning to welcome
    const looseApp = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "aed.recentWorkspaces": "[]",
      },
      host: {
        params: {
          openFile: `${FIXTURE_ROOT}/README.md`,
        },
      },
    });
    await looseApp.waitFor("id:preview-markdown");
    expect(looseApp.shows("id:workspace-tree")).toBe(false);
    await looseApp.press("id:tab-close-README.md");
    await looseApp.waitFor("id:welcome-panel");
    expect(looseApp.shows("id:welcome-panel")).toBe(true);
  });
  test("dropping any file onto a workspace window opens it as a tab and keeps the file tree", async () => {
    await withScratch({ "note.txt": "NOTE_V1" }, async ({ app }) => {
      await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}/main.ts`]);
      await app.waitFor("id:tab-select-main.ts");
      expect(app.shows("id:workspace-tree")).toBe(true);
      expect(app.shows("id:tab-select-note.txt")).toBe(true);
    });
  });

  test("a second guarded action cannot replace an open unsaved-changes prompt", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    await app.type("id:preview-editor", "// unsaved\n");
    await app.press("id:tab-close-main.ts");
    await app.waitFor("id:unsaved-changes-dialog");
    await app.keyboard.press("mod+shift+w");
    await app.press("id:unsaved-discard-btn");
    expect(app.shows("id:tab-select-main.ts")).toBe(false);
    expect(app.shows("id:workspace-tree")).toBe(true);
    expect(app.shows("id:welcome-panel")).toBe(false);
  });

  test("reopening a file shows changes made on disk after Aed first read it", async () => {
    await withScratch({ "note.txt": "STALE_V1" }, async ({ app, write }) => {
      await app.press("id:tab-close-note.txt");
      await write("note.txt", "FRESH_V2");
      await app.press("text:note.txt");
      await app.waitUntil(() => showsText(app, "FRESH_V2"), { timeout: 5000 });
      expect(showsText(app, "STALE_V1")).toBe(false);
    });
  });

  test("an open clean tab shows changes made on disk without reopening", async () => {
    await withScratch({ "note.txt": "OPEN_V1" }, async ({ app, write }) => {
      await write("note.txt", "OPEN_V2");
      await app.waitUntil(() => showsText(app, "OPEN_V2"), { timeout: 6000 });
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
    });
  });

  test("a tab with unsaved edits that changed on disk asks to keep the edits or reload", async () => {
    await withScratch({ "note.txt": "DISK_V1" }, async ({ app, write }) => {
      await editTab(app, "MINE ");
      // Unsaved edits alone are not a conflict.
      await pastOneDiskCheck();
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
      await write("note.txt", "DISK_V2");
      await app.waitFor("id:disk-conflict-banner");
      // Keep: the edits stay, the banner goes, and it stays gone.
      await app.press("id:disk-conflict-keep-btn");
      await app.waitUntil(() => !app.shows("id:disk-conflict-banner"), { timeout: 3000 });
      await pastOneDiskCheck();
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
      expect(showsText(app, "•")).toBe(true);
      expect(showsText(app, "DISK_V2")).toBe(false);
      // A newer disk change asks again; Reload drops the edits and shows the disk.
      await write("note.txt", "DISK_V3");
      await app.waitFor("id:disk-conflict-banner");
      await app.press("id:disk-conflict-reload-btn");
      await app.waitUntil(() => showsText(app, "DISK_V3"), { timeout: 5000 });
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
      expect(showsText(app, "•")).toBe(false);
    });
  });

  test("saving or closing a conflicted tab ends its conflict at once, not at the next disk check", async () => {
    await withScratch({ "note.txt": "SAVE_V1" }, async ({ app, write }) => {
      // Save over the disk change, then type again at once: no banner.
      await editTab(app, "MINE ");
      await write("note.txt", "SAVE_V2");
      await app.waitFor("id:disk-conflict-banner");
      await app.keyboard.press("mod+s");
      await app.waitUntil(() => !showsText(app, "•"), { timeout: 3000 });
      await editTab(app, "MORE ");
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
      await pastOneDiskCheck();
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
      // Close without saving, reopen, type at once: no banner left from the closed copy.
      await write("note.txt", "SAVE_V3");
      await app.waitFor("id:disk-conflict-banner");
      await app.press("id:tab-close-note.txt");
      await app.press("id:unsaved-discard-btn");
      await app.press("text:note.txt");
      await app.waitUntil(() => showsText(app, "SAVE_V3"), { timeout: 5000 });
      await editTab(app, "AGAIN ");
      expect(app.shows("id:disk-conflict-banner")).toBe(false);
    });
  });

  test("a tab that becomes active is checked against the disk at once; each tab keeps its own conflict", async () => {
    await withScratch({ "a.txt": "A_V1", "b.txt": "B_V1" }, async ({ app, write }) => {
      await app.press("text:b.txt");
      await app.waitUntil(() => showsText(app, "B_V1"), { timeout: 5000 });
      // Well under one DISK_CHECK_MS: the switch itself checks. Two rounds, so a
      // periodic check that happens to land in the window passes by luck only ~3%.
      for (const version of ["A_V2", "A_V3"]) {
        await write("a.txt", version);
        await pastOneDiskCheck();
        await app.press("id:tab-select-a.txt");
        await app.waitUntil(() => showsText(app, version), { timeout: 250 });
        await app.press("id:tab-select-b.txt");
        await app.waitUntil(() => showsText(app, "B_V1"), { timeout: 2000 });
      }
      await app.press("id:tab-select-a.txt");
      // Two conflicted tabs: each shows its own banner as soon as it is active.
      await editTab(app, "MINE_A ");
      await write("a.txt", "A_V4");
      await app.waitFor("id:disk-conflict-banner");
      await app.press("id:tab-select-b.txt");
      await editTab(app, "MINE_B ");
      await write("b.txt", "B_V2");
      await app.waitFor("id:disk-conflict-banner");
      await app.press("id:tab-select-a.txt");
      await app.waitUntil(() => app.shows("id:disk-conflict-banner"), { timeout: 300 });
    });
  });

  test("a terminal the user has not typed into moves to the folder that opens", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}`]);
    await app.waitFor("id:workspace-tree");
    await runInTerminal(app, "pwd", "PWD_DONE");
    expect(showsText(app, FIXTURE_ROOT)).toBe(true);
    // Once used, the shell keeps its directory (and screen) when the folder closes.
    await app.keyboard.press("mod+shift+w");
    await app.waitFor("id:welcome-panel");
    await runInTerminal(app, "pwd", "PWD_AGAIN");
    expect(app.texts().filter((t) => t === FIXTURE_ROOT).length).toBe(2);
  });

  test("a command submitted the moment the terminal opens still runs", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    await app.type("id:terminal-input", "echo FIRST_CMD_RAN");
    await app.submit("id:terminal-input");
    await app.waitUntil(() => showsText(app, "FIRST_CMD_RAN"), { timeout: 8000 });
  });

  test("a command submitted after the shell ended starts a new shell", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    await runInTerminal(app, "true", "SHELL_UP");
    await app.type("id:terminal-input", "exit");
    await app.submit("id:terminal-input");
    await app.waitUntil(() => app.texts().some((t) => t.endsWith("session ended")), { timeout: 8000 });
    await runInTerminal(app, "true", "SHELL_BACK");
  });

  test("a half-typed terminal command stays, with its shell, when a folder opens", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    await app.type("id:terminal-input", "echo DRAFT_KEPT");
    await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}`]);
    await app.waitFor("id:workspace-tree");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The input values are not in texts(): submit the kept draft and read its output.
    await app.submit("id:terminal-input");
    await app.waitUntil(() => showsText(app, "DRAFT_KEPT"), { timeout: 8000 });
    await runInTerminal(app, "pwd", "PWD_DONE");
    expect(showsText(app, FIXTURE_ROOT)).toBe(false);
  });

});
