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
  followLatest,
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
  windowTitle,
  WINDOW_TRANSITIONS,
  type WindowEvent,
  type WindowMode,
  runApprovedQuit,
} from "./src/session";
import { createInputGate, linkTarget, parseGhosttyConfig, shouldFollowCwd } from "./src/TerminalPane";
import { sortRows } from "./src/PreviewPane";
import manifest from "./nsh.json";
import {
  computeSyntaxDecorations,
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  fontDisplayName,
  getThemeById,
} from "./src/themes";
import {
  externalFileCandidates,
  isBehindDisk,
  normalizeExternalFilePath,
  shortenHomePath,
  type LoadedFile,
} from "./src/workspace";
import { saveInStore } from "./src/saving";
import * as fs from "fs/promises";
import * as os from "os";
import { withPreviewCsp } from "./src/PreviewPane";
import {
  buildPreviewShellHtml,
  buildPreviewThemeCss,
  classifyPreviewLink,
  handlePreviewMessage,
  parsePreviewMessage,
  resolvePreviewImagePath,
  type PreviewBridgeDeps,
  type PreviewMessage,
} from "./src/markdownPage";
import { buildMermaidConfig, rememberRender } from "./src/mermaid";
import { MARKDOWN_RUNTIME_JS } from "./src/markdownVendor.generated";
import { ANSI_NAMES, ANSI_PALETTES, buildTerminalTheme } from "./src/terminalTheme";

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

    const pending = { action: "close-tab" as const, dirtyPaths: ["/w/a.ts"], onProceed: () => {} };
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
      (text: string) => written.push(text),
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
      (text: string) => silentWritten.push(text),
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

/**
 * `aed.terminal.test`, the terminal's test channel: what the native view would
 * do for the active tab (headless tests have none). The first message turns on
 * the plain-text mirror `app.texts()` reads.
 */
async function termTest(app: TestApp, message: Record<string, unknown>): Promise<void> {
  await app.host.send("aed.terminal.test", message);
}

/** Keys typed into the active terminal tab (`\r` is Enter). */
const termType = (app: TestApp, data: string) => termTest(app, { type: "input", data });

async function runInTerminal(app: TestApp, cmd: string, marker: string): Promise<void> {
  if (!app.shows("id:terminal-pane")) {
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
  }
  await termType(app, `${cmd} && echo ${marker}\r`);
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
  /** Run a shell command in the window's terminal and wait for it to succeed. */
  run: (cmd: string) => Promise<void>;
}

/**
 * Run `body` in a window on a fresh scratch folder holding `files` (name → one line),
 * with `files`' first name open. `extra` adds shell commands run after the files are
 * written and before the window opens (binary samples, git, chmod). The folder is
 * removed afterwards, also on failure.
 */
async function withScratch(
  files: Record<string, string>,
  body: (s: Scratch) => Promise<void>,
  extra: (dir: string) => string[] = () => []
) {
  const { dir, remove } = await makeScratch((d) => [
    ...Object.entries(files).map(([n, c]) => `printf '${c}\\n' > ${d}/${n}`),
    ...extra(d),
  ]);
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 800,
    host: { params: { workspaceRoot: dir } },
  });
  let step = 0;
  const write = (name: string, content: string) =>
    runInTerminal(app, `printf '${content}\\n' > ${dir}/${name}`, `WRITE_DONE_${(step += 1)}`);
  const run = (cmd: string) => runInTerminal(app, cmd, `RUN_DONE_${(step += 1)}`);
  try {
    const [first, content] = Object.entries(files)[0];
    await app.waitFor(`text:${first}`);
    await app.press(`text:${first}`);
    await app.waitUntil(() => showsText(app, content), { timeout: 5000 });
    await body({ app, dir, write, run });
  } finally {
    await remove();
  }
}

/**
 * A fresh scratch folder, filled by `commands(dir)` in a helper window's terminal (the
 * test sandbox cannot write files). `remove` deletes it; call it in a `finally`.
 */
async function makeScratch(
  commands: (dir: string) => string[]
): Promise<{ dir: string; remove: () => Promise<void> }> {
  scratchCount += 1;
  const dir = `${SCRATCH_RUN}-${scratchCount}`;
  const setup = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
  const all = [`rm -rf ${dir}`, `mkdir -p ${dir}`, ...commands(dir)];
  await runInTerminal(setup, all.join(" && "), "SETUP_DONE");
  // u+rwx first: a test may lock a folder (chmod 000).
  const remove = () => runInTerminal(setup, `chmod -R u+rwx ${dir} 2>/dev/null; rm -rf ${dir}`, "CLEAN_DONE");
  return { dir, remove };
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

    // 13. Quick Open + Markdown WebView preview & standalone .mmd Mermaid block + Copy
    expect(app.shows("text:fixtures")).toBe(true);
    await app.press("id:titlebar-quick-open");
    await app.waitFor("id:command-palette");
    await app.type("id:command-palette", "guide.md");
    await app.keyboard.press("enter");
    await app.waitFor("id:preview-markdown");
    expect(app.shows("id:preview-markdown")).toBe(true);

    await app.press("text:architecture.mmd");
    await app.waitFor("id:preview-mermaid");
    expect(app.shows("id:preview-mermaid")).toBe(true);
    await app.waitFor("id:mermaid-block >> nth=0");
    expect(app.shows("id:mermaid-block >> nth=0")).toBe(true);
    expect(app.shows("text:MERMAID")).toBe(false);
    await app.press("id:mermaid-copy-code >> nth=0");
    await app.press("id:mermaid-toggle-code >> nth=0");
    await app.waitFor("id:mermaid-code-view");
    await app.press("id:mermaid-toggle-code >> nth=0");
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
    expect(app.shows("id:terminal-view")).toBe(true);
    expect(app.shows("id:terminal-input")).toBe(false);
    await termType(app, "echo NSH_PTY_OK_2026\r");
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
    // The tree header holds only the folder name and the All / Changed filter.
    expect(app.shows("id:sidebar-open-folder")).toBe(false);
    expect(app.shows("id:sidebar-close-folder")).toBe(false);
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
    await app.keyboard.press("mod+shift+w");
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
    await termType(app, "echo FIRST_CMD_RAN\r");
    await app.waitUntil(() => showsText(app, "FIRST_CMD_RAN"), { timeout: 8000 });
  });

  test("test shells keep their history out of the user's home", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, 'echo "HF=$HISTFILE"', "HIST_SHOWN");
    const line = app.texts().find((t) => t.startsWith("HF="));
    expect(line).toBeDefined();
    expect(line).toContain("/aed-shell-");
    expect(line?.startsWith(`HF=${os.homedir()}/`)).toBe(false);
  });

  test("the last tab's shell exiting closes the terminal, and opening it starts a fresh shell", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "true", "SHELL_UP");
    await termType(app, "exit\r");
    await app.waitUntil(() => !app.shows("id:terminal-pane"), { timeout: 8000 });
    await runInTerminal(app, "true", "SHELL_BACK");
    expect(app.texts().some((t) => t.startsWith("1: "))).toBe(false);
    expect(app.texts().some((t) => t.startsWith("2: "))).toBe(true);
  });

  test("a shell exiting closes only its tab", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "true", "FIRST_UP");
    await app.press("id:terminal-add-btn");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("2: ")), { timeout: 8000 });
    await runInTerminal(app, "true", "SECOND_UP");
    await termType(app, "exit\r");
    await app.waitUntil(() => !app.texts().some((t) => t.startsWith("2: ")), { timeout: 8000 });
    expect(app.shows("id:terminal-pane")).toBe(true);
    await runInTerminal(app, "true", "FIRST_STILL_UP");
  });

  test("a half-typed terminal command stays, with its shell, when a folder opens", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    // Keys go to the shell at once: a half-typed command is in its line editor.
    await termType(app, "echo DRAFT_KEPT");
    await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}`]);
    await app.waitFor("id:workspace-tree");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await termType(app, "\r");
    await app.waitUntil(() => showsText(app, "DRAFT_KEPT"), { timeout: 8000 });
    await runInTerminal(app, "pwd", "PWD_DONE");
    expect(showsText(app, FIXTURE_ROOT)).toBe(false);
  });

});

/** Run a command palette entry by its label. */
async function runCommand(app: TestApp, label: string): Promise<void> {
  await app.keyboard.press("mod+shift+p");
  await app.waitFor("id:command-palette");
  await app.type("id:command-palette", label);
  await app.keyboard.press("enter");
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

describe("file safety (I-015)", () => {
  test("saving an image, binary or PDF tab never writes to it", async () => {
    const opaque = ["poster.png", "sample.bin", "manual.pdf"];
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app, dir }) => {
        for (const name of opaque) {
          await app.press(`text:${name}`);
          await app.waitFor(`id:tab-select-${name}`);
          await app.keyboard.press("mod+s");
          await runCommand(app, "File: Save Current File");
        }
        await app.wait(300);
        const same = opaque.map((n) => `cmp -s ${dir}/${n} ${FIXTURE_ROOT}/${n}`).join(" && ");
        await runInTerminal(app, same, "OPAQUE_UNTOUCHED");
      },
      (dir) => opaque.map((n) => `cp ${FIXTURE_ROOT}/${n} ${dir}/`)
    );
  });

  test("a file that is not UTF-8 opens read-only and is never rewritten", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app, dir }) => {
        await app.press("text:latin1.txt");
        await app.waitFor("id:tab-select-latin1.txt");
        await app.keyboard.press("mod+s");
        await app.wait(300);
        await runInTerminal(app, `cmp -s ${dir}/latin1.txt ${dir}/.orig/latin1.txt`, "LATIN1_UNTOUCHED");
        await app.press("id:tab-select-latin1.txt");
        await app.waitFor("id:read-only-banner");
        // The editor takes no typing: the tab never becomes dirty.
        await app.type("id:preview-editor", "X").catch(() => undefined);
        await app.wait(100);
        expect(showsText(app, "•")).toBe(false);
      },
      (dir) => [`printf 'caf\\xe9\\n' > ${dir}/latin1.txt`, `mkdir ${dir}/.orig`, `cp ${dir}/latin1.txt ${dir}/.orig/`]
    );
  });

  test("a UTF-8 BOM survives a save", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app, dir }) => {
        await app.press("text:bom.txt");
        await app.waitUntil(() => showsText(app, "BOM_V1"), { timeout: 5000 });
        await editTab(app, "MORE");
        await app.keyboard.press("mod+s");
        await app.waitUntil(() => !showsText(app, "•"), { timeout: 3000 });
        await runInTerminal(app, `head -c 3 ${dir}/bom.txt | xxd -p | grep -qx efbbbf`, "BOM_KEPT");
      },
      (dir) => [`printf '\\xef\\xbb\\xbfBOM_V1\\n' > ${dir}/bom.txt`]
    );
  });

  test("source and diff modes are not offered for opaque files", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:poster.png");
    for (const [name, view] of [
      ["poster.png", "id:preview-image"],
      ["sample.bin", "id:preview-hex"],
    ]) {
      await app.press(`text:${name}`);
      await app.waitFor(view);
      for (const label of ["View: Switch to Source Mode", "View: Switch to Diff Mode"]) {
        await runCommand(app, label);
        await app.wait(200);
        expect(`${name} ${label}: ${app.shows(view)}`).toBe(`${name} ${label}: true`);
        expect(app.shows("id:preview-editor")).toBe(false);
        expect(app.shows("id:preview-diff")).toBe(false);
      }
    }
  });

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

  test("a failed save says so and keeps the tab dirty", async () => {
    await withScratch(
      { "note.txt": "LOCKED_V1" },
      async ({ app, dir }) => {
        await editTab(app, "MINE ");
        await app.keyboard.press("mod+s");
        await app.waitFor("id:save-error-banner");
        expect(showsText(app, "•")).toBe(true);
        expect(app.texts().some((t) => t.includes(`${dir}/note.txt`))).toBe(true);
      },
      (dir) => [`chmod 444 ${dir}/note.txt`]
    );
  });

  test("a saved SVG shows its new picture", async () => {
    const svg = (w: number, h: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"></svg>`;
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app }) => {
        await app.press("text:pic.svg");
        await app.waitUntil(() => showsText(app, "10 × 20 · image/svg+xml"), { timeout: 5000 });
        await app.press("id:mode-source");
        await app.waitFor("id:preview-editor");
        await app.clear("id:preview-editor");
        await app.paste("id:preview-editor", { text: svg(30, 40) });
        await app.waitUntil(() => showsText(app, "•"), { timeout: 3000 });
        await app.keyboard.press("mod+s");
        await app.waitUntil(() => !showsText(app, "•"), { timeout: 3000 });
        await app.press("id:mode-preview");
        await app.waitUntil(() => showsText(app, "30 × 40 · image/svg+xml"), { timeout: 3000 });
      },
      (dir) => [`printf '${svg(10, 20)}\\n' > ${dir}/pic.svg`]
    );
  });

  test("the diff view follows a save", async () => {
    await withScratch(
      { "a.txt": "A_V1", "note.txt": "DIFF_V1" },
      async ({ app }) => {
        // The launch scan's git status is in (it is not killed with its effect).
        await app.waitUntil(() => showsText(app, "M"), { timeout: 5000 });
        await app.press("id:sidebar-filter-changed");
        await app.press("text:note.txt");
        await app.waitFor("id:preview-diff");
        await runCommand(app, "View: Switch to Source Mode");
        await app.waitFor("id:preview-editor");
        await editTab(app, "SAVED_LINE");
        await app.keyboard.press("mod+s");
        await app.waitUntil(() => !showsText(app, "•"), { timeout: 3000 });
        await runCommand(app, "View: Switch to Diff Mode");
        await app.waitFor("id:preview-diff");
        await app.waitUntil(() => app.texts().some((t) => t.includes("SAVED_LINE")), { timeout: 3000 });
      },
      (dir) => [
        `git -C ${dir} init -q`,
        `git -C ${dir} add -A`,
        `git -C ${dir} -c user.name=t -c user.email=t@t commit -qm init`,
        `printf 'DIFF_V2\\n' > ${dir}/note.txt`,
      ]
    );
  });

  test("the unsaved-changes prompt names the action it guards", async () => {
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
    const asks = async (act: () => Promise<void>, question: string) => {
      await act();
      await app.waitFor("id:unsaved-changes-dialog");
      expect(showsText(app, question)).toBe(true);
      await app.press("id:unsaved-cancel-btn");
    };
    await asks(() => app.press("id:tab-close-main.ts"), "Save changes to main.ts before closing?");
    await asks(() => app.keyboard.press("mod+shift+w"), "Save changes to main.ts before closing the folder?");
    await asks(
      () => app.dropFiles("id:app-root", ["file:///tmp"]),
      "Save changes to main.ts before opening another folder?"
    );
  });
});

describe("quit guard (I-016)", () => {
  test("a quit the host does not carry out arms the guard again", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const refused: boolean[] = [];
    runApprovedQuit((v) => refused.push(v), () => {
      throw new Error("process.exit is not granted");
    });
    await sleep(10);
    expect(refused).toEqual([true, false]);
    const cancelled: boolean[] = [];
    runApprovedQuit((v) => cancelled.push(v), () => undefined, 20);
    await sleep(80);
    expect(cancelled).toEqual([true, false]);
  });

  // ⌘Q is the menu's (headless runs have no menu bar); the palette runs the same action.
  // A quit the guard lets through ends the app: its next step rejects with "the app left".
  const quitLeaves = async (app: TestApp) => {
    await expect(app.waitFor("id:welcome-panel", { timeout: 300 })).rejects.toThrow("the app left");
  };

  test("quitting with unsaved edits asks first", async () => {
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
    await runCommand(app, "File: Quit Aed");
    await app.waitFor("id:unsaved-changes-dialog");
    expect(showsText(app, "Save changes to main.ts before quitting?")).toBe(true);
    await app.press("id:unsaved-cancel-btn");
    expect(app.shows("id:tab-select-main.ts")).toBe(true);
    await runCommand(app, "File: Quit Aed");
    await app.waitFor("id:unsaved-changes-dialog");
    await app.press("id:unsaved-discard-btn");
    await quitLeaves(app);
  });

  test("the window title carries the edited mark scripts/finder_bridge.m reads", () => {
    expect(windowTitle(false)).toBe("Aed");
    expect(windowTitle(true)).toBe("Aed — Edited");
  });

  test("quitting with nothing unsaved quits at once", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await runCommand(app, "File: Quit Aed");
    await quitLeaves(app);
  });
});

describe("workspace follows the disk (I-014)", () => {
  /** Longer than two workspace polls (WORKSPACE_POLL_MS = 2000). */
  const pastPolls = { timeout: 7000 };
  const shown = (app: TestApp, text: string) => app.waitUntil(() => showsText(app, text), pastPolls);
  const gone = (app: TestApp, text: string) => app.waitUntil(() => !showsText(app, text), pastPolls);

  test("a folder renamed outside Aed shows its new name in the tree", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app, dir, run }) => {
        await app.press("text:old-name");
        await shown(app, "a.txt");
        await app.press("text:a.txt");
        await app.waitFor("id:tab-select-a.txt");
        const rows = app.count("text:a.txt");
        await run(`mv ${dir}/old-name ${dir}/new-name`);
        await shown(app, "new-name");
        await gone(app, "old-name");
        // Still expanded, still selected, and the tab follows: the save lands at the new path.
        expect(app.count("text:a.txt")).toBe(rows);
        expect(app.shows("id:file-missing-banner")).toBe(false);
        await editTab(app, "EDITED");
        await app.keyboard.press("mod+s");
        await app.waitUntil(() => !showsText(app, "•"), { timeout: 3000 });
        await run(`grep -q EDITED ${dir}/new-name/a.txt && test ! -e ${dir}/old-name`);
      },
      (dir) => [`mkdir -p ${dir}/old-name`, `printf 'hello\\n' > ${dir}/old-name/a.txt`]
    );
  });

  test("an open tab whose file was moved or deleted says so and does not recreate it on save", async () => {
    await withScratch({ "note.txt": "NOTE_V1" }, async ({ app, dir, run }) => {
      await editTab(app, "MINE");
      await run(`rm ${dir}/note.txt`);
      await app.waitFor("id:file-missing-banner", pastPolls);
      await app.keyboard.press("mod+s");
      await app.waitFor("id:save-error-banner");
      await run(`test ! -e ${dir}/note.txt`);
      expect(showsText(app, "•")).toBe(true);
    });
  });

  test("the Changed list follows git status changes made outside Aed", async () => {
    const git = (dir: string) => `git -C ${dir} -c user.name=t -c user.email=t@t`;
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app, dir, run }) => {
        await app.press("id:sidebar-filter-changed");
        expect(showsText(app, "other.txt")).toBe(false);
        await run(`printf 'more\\n' >> ${dir}/other.txt`);
        await shown(app, "other.txt");
        await run(`${git(dir)} commit -qam next`);
        await gone(app, "other.txt");
      },
      (dir) => [
        `printf 'o\\n' > ${dir}/other.txt`,
        `${git(dir)} init -q`,
        `${git(dir)} add .`,
        `${git(dir)} commit -qm init`,
      ]
    );
  });

  test("an unreadable folder is shown as unreadable, not empty", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app }) => {
        await app.press("text:locked");
        await shown(app, "Cannot read this folder");
      },
      (dir) => [`mkdir ${dir}/locked`, `printf 'x\\n' > ${dir}/locked/f.txt`, `chmod 000 ${dir}/locked`]
    );
  });

  test("ignored entries do not count toward the per-folder limit, and truncation is shown", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app }) => {
        await app.press("text:big");
        await shown(app, "f001.txt");
        await app.scroll("id:workspace-tree", 6000);
        await shown(app, "5 more items not shown");
        expect(showsText(app, "f200.txt")).toBe(true);
        expect(showsText(app, "f201.txt")).toBe(false);
      },
      (dir) => [
        `mkdir ${dir}/big`,
        `mkdir ${dir}/big/.h{1..300}`,
        `touch ${dir}/big/f{001..205}.txt`,
      ]
    );
  });

  test("a workspace folder deleted outside Aed says so", async () => {
    await withScratch({ "note.txt": "NOTE_V1" }, async ({ app, dir, run }) => {
      await run(`rm -rf ${dir}`);
      await shown(app, "This folder was moved or deleted.");
      expect(app.shows("text:note.txt")).toBe(true); // the tab stays, with its own banner
    });
  });

  test("every icon-only button has an accessible name", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await app.press("text:main.ts");
    await app.waitFor("id:tab-select-main.ts");
    const named = (labels: string[]) => {
      for (const label of labels) expect(`${label}: ${app.shows(`label:${label}`)}`).toBe(`${label}: true`);
    };
    named(["Close main.ts", "Toggle sidebar", "Toggle terminal", "Show all files", "Show changed files"]);
    await app.press("text:poster.png");
    await app.waitFor("id:image-zoom-in");
    named(["Zoom out", "Zoom in"]);
    await app.keyboard.press("mod+,");
    await app.waitFor("id:font-settings-dialog");
    named(["Close preferences"]);
  });
});

const PREVIEW_SPEC_MD = `# 文档标题

## 根因

正文段落，包含**加粗**与 \`inline code\`。

## 根因

> [!NOTE]
> 提示内容。

> [!WARNING]
> 警告内容。

- [x] 完成项
- [ ] 未完成项

脚注引用[^f1]。

[^f1]: 脚注说明。

行内公式 $E=mc^2$ 与块级公式：

$$
\\int_0^1 x^2\\,dx
$$

| A | B |
|---|---|
| 1 | 2 |

\`\`\`ts
const answer: number = 42;
\`\`\`

\`\`\`mermaid
graph TD; A--<B
\`\`\`

\`\`\`frobnicate
<raw> & text
\`\`\`
`;

interface RenderedMd {
  html: string;
  headings: { level: number; text: string; id: string }[];
}

async function evalMarkdownRuntime(): Promise<
  typeof globalThis.AedMarkdown
> {
  // QuickJS disables the Function constructor; importing the built artifact
  // runs the same IIFE that MARKDOWN_RUNTIME_JS injects into the page.
  await import("./vendor/markdown/dist/markdown-runtime.js");
  return globalThis.AedMarkdown;
}

function fakeDeps(overrides: Partial<PreviewBridgeDeps> = {}) {
  const calls = {
    openUrls: [] as string[],
    openFiles: [] as string[],
    readImages: [] as string[],
    injects: [] as string[],
    scrolls: [] as [string, number][],
    mermaidLoadCount: 0,
  };
  const deps: PreviewBridgeDeps = {
    basePath: () => "/ws/docs/guide.md",
    openUrl: (url) => {
      calls.openUrls.push(url);
    },
    openFile: (p) => {
      calls.openFiles.push(p);
    },
    readImageDataUrl: async (p) => {
      calls.readImages.push(p);
      return `data:image/png;base64,${p.length}`;
    },
    inject: (js) => {
      calls.injects.push(js);
    },
    loadMermaidJs: async () => {
      calls.mermaidLoadCount += 1;
      return "MERMAID_BUNDLE";
    },
    rememberScroll: (p, y) => {
      calls.scrolls.push([p, y]);
    },
    currentRenderId: () => 7,
    mermaidConfig: () => ({ theme: "base" }),
    ...overrides,
  };
  return { calls, deps };
}

describe("markdown preview runtime & bridge", () => {
  test("runtime evaluates without document and renders all features", async () => {
    let md: Awaited<ReturnType<typeof evalMarkdownRuntime>> | null = null;
    md = await evalMarkdownRuntime();
    const r = md.renderMarkdown(PREVIEW_SPEC_MD);

    // Duplicate CJK headings get deduped GitHub-style ids.
    const h = r.headings.filter((x) => x.text === "根因");
    expect(h).toEqual([
      { level: 2, text: "根因", id: "根因" },
      { level: 2, text: "根因", id: "根因-1" },
    ]);
    expect(r.headings[0]).toEqual({ level: 1, text: "文档标题", id: "文档标题" });

    expect(r.html).toContain('class="markdown-alert markdown-alert-note"');
    expect(r.html).toContain('class="markdown-alert markdown-alert-warning"');
    expect(r.html).toContain("task-list-item-checkbox");
    expect(r.html).toContain("disabled");
    expect(r.html).toContain('id="fnref1"');
    expect(r.html).toContain('id="fn1"');
    expect(r.html).toContain('class="katex"');
    expect(r.html).toContain('<pre class="mermaid">');
    expect(r.html).toContain("A--&lt;B");
    expect(r.html).toContain("hljs-keyword");
    expect(r.html).toContain("&lt;raw&gt; &amp; text");

    // The committed dist artifact and MARKDOWN_RUNTIME_JS share one build.
    expect(md.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(MARKDOWN_RUNTIME_JS).toContain(md.buildId);
  });

  test("classifyPreviewLink routes external/file/none", () => {
    const base = "/ws/docs/guide.md";
    expect(classifyPreviewLink("https://example.com/x", base)).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(classifyPreviewLink("http://a.b", base)).toEqual({
      kind: "external",
      url: "http://a.b",
    });
    expect(classifyPreviewLink("mailto:a@b.c", base)).toEqual({
      kind: "external",
      url: "mailto:a@b.c",
    });
    expect(classifyPreviewLink("HTTPS://EXAMPLE.COM", base)).toEqual({
      kind: "external",
      url: "HTTPS://EXAMPLE.COM",
    });
    expect(classifyPreviewLink("ssh://host/x", base)).toEqual({
      kind: "none",
    });
    expect(classifyPreviewLink("x-apple.systempreferences:", base)).toEqual({
      kind: "none",
    });
    expect(classifyPreviewLink("javascript:alert(1)", base)).toEqual({
      kind: "none",
    });
    expect(classifyPreviewLink("data:text/html,x", base)).toEqual({
      kind: "none",
    });
    expect(classifyPreviewLink("", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("#frag", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("./b.md#x", base)).toEqual({
      kind: "file",
      path: "/ws/docs/b.md",
    });
    expect(classifyPreviewLink("../docs/a%20b.md", base)).toEqual({
      kind: "file",
      path: "/ws/docs/a b.md",
    });
    expect(classifyPreviewLink("file:///tmp/x.md", base)).toEqual({
      kind: "file",
      path: "/tmp/x.md",
    });
    expect(classifyPreviewLink("/abs/y.md", base)).toEqual({
      kind: "file",
      path: "/abs/y.md",
    });
  });

  test("resolvePreviewImagePath accepts image paths only", () => {
    const base = "/ws/docs/guide.md";
    expect(resolvePreviewImagePath("poster.png", base)).toBe(
      "/ws/docs/poster.png",
    );
    expect(resolvePreviewImagePath("../img/a.jpeg", base)).toBe(
      "/ws/img/a.jpeg",
    );
    expect(resolvePreviewImagePath("/tmp/p.svg", base)).toBe("/tmp/p.svg");
    expect(resolvePreviewImagePath("file:///tmp/p.webp", base)).toBe(
      "/tmp/p.webp",
    );
    expect(resolvePreviewImagePath("my%20pic.png", base)).toBe(
      "/ws/docs/my pic.png",
    );
    expect(resolvePreviewImagePath("p.png?v=1", base)).toBe("/ws/docs/p.png");
    expect(resolvePreviewImagePath("p.png#x", base)).toBe("/ws/docs/p.png");
    expect(resolvePreviewImagePath("p.PNG", base)).toBe("/ws/docs/p.PNG");
    expect(resolvePreviewImagePath("https://x.io/p.png", base)).toBeNull();
    expect(resolvePreviewImagePath("data:image/png;base64,AA", base)).toBeNull();
    expect(resolvePreviewImagePath("notes.txt", base)).toBeNull();
    expect(resolvePreviewImagePath("", base)).toBeNull();
  });

  test("parsePreviewMessage validates shape strictly", () => {
    expect(parsePreviewMessage('{"type":"link","href":"https://a.b"}')).toEqual(
      { type: "link", href: "https://a.b" },
    );
    expect(
      parsePreviewMessage('{"type":"images","renderId":3,"srcs":["a.png"]}'),
    ).toEqual({ type: "images", renderId: 3, srcs: ["a.png"] });
    expect(
      parsePreviewMessage('{"type":"scroll","path":"/x.md","y":120}'),
    ).toEqual({ type: "scroll", path: "/x.md", y: 120 });
    expect(parsePreviewMessage('{"type":"needMermaid"}')).toEqual({
      type: "needMermaid",
    });
    expect(parsePreviewMessage("not json")).toBeNull();
    expect(parsePreviewMessage('{"type":"wat"}')).toBeNull();
    expect(parsePreviewMessage('{"type":"link","href":1}')).toBeNull();
    expect(
      parsePreviewMessage('{"type":"images","renderId":"3","srcs":[]}'),
    ).toBeNull();
    expect(parsePreviewMessage('{"type":"scroll","path":1,"y":2}')).toBeNull();
    const big = JSON.stringify({
      type: "images",
      renderId: 1,
      srcs: Array.from({ length: 250 }, (_, i) => `s${i}`),
    });
    const parsed = parsePreviewMessage(big);
    expect(parsed?.type).toBe("images");
    expect((parsed as { srcs: string[] }).srcs.length).toBe(200);
  });

  test("handlePreviewMessage routes link/images/scroll/mermaid", async () => {
    // https link → openUrl once, openFile never.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage(
        { type: "link", href: "https://example.com/x" },
        deps,
      );
      expect(calls.openUrls).toEqual(["https://example.com/x"]);
      expect(calls.openFiles).toEqual([]);
    }
    // relative link → openFile with resolved path.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage({ type: "link", href: "./b.md" }, deps);
      expect(calls.openFiles).toEqual(["/ws/docs/b.md"]);
      expect(calls.openUrls).toEqual([]);
    }
    // javascript link → nothing.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage(
        { type: "link", href: "javascript:alert(1)" },
        deps,
      );
      expect(calls.openUrls).toEqual([]);
      expect(calls.openFiles).toEqual([]);
    }
    // images → reads only resolvable srcs, one setImages inject.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage(
        {
          type: "images",
          renderId: 7,
          srcs: ["p.png", "https://x.io/a.png", "notes.txt"],
        },
        deps,
      );
      expect(calls.readImages).toEqual(["/ws/docs/p.png"]);
      expect(calls.injects.length).toBe(1);
      expect(calls.injects[0]).toContain("__aed.setImages");
      expect(calls.injects[0]).toContain('"renderId":7');
      expect(calls.injects[0]).toContain('"https://x.io/a.png":null');
      expect(calls.injects[0]).toContain('"notes.txt":null');
    }
    // stale renderId → nothing.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage(
        { type: "images", renderId: 3, srcs: ["p.png"] },
        deps,
      );
      expect(calls.readImages).toEqual([]);
      expect(calls.injects).toEqual([]);
    }
    // needMermaid with bundle → bundle injected then mermaidReady.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage({ type: "needMermaid" }, deps);
      expect(calls.injects[0]).toBe("MERMAID_BUNDLE");
      expect(calls.injects[1]).toContain("__aed.mermaidReady");
    }
    // needMermaid without bundle → mermaidUnavailable.
    {
      const { calls, deps } = fakeDeps({ loadMermaidJs: async () => null });
      await handlePreviewMessage({ type: "needMermaid" }, deps);
      expect(calls.injects[0]).toContain("__aed.mermaidUnavailable");
    }
    // scroll → rememberScroll.
    {
      const { calls, deps } = fakeDeps();
      await handlePreviewMessage(
        { type: "scroll", path: "/ws/a.md", y: 420 },
        deps,
      );
      expect(calls.scrolls).toEqual([["/ws/a.md", 420]]);
    }
  });

  test("buildPreviewShellHtml carries the strict CSP and no script tags", () => {
    const html = buildPreviewShellHtml();
    expect(html).toContain(
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(html).not.toContain("<script");
    expect(html).toContain('id="aed-content"');
    expect(html).toContain('id="aed-toc"');
    expect(html).toContain('id="aed-theme"');
  });

  test("buildPreviewThemeCss maps theme + font to preview CSS", () => {
    const carbon = getThemeById("industrial-carbon")!;
    const paper = getThemeById("industrial-paper")!;
    const darkCss = buildPreviewThemeCss(carbon, {
      fontFamily: "Menlo",
      fontSize: 14,
    });
    expect(darkCss).toContain(carbon.ui.background);
    expect(darkCss).toContain(carbon.ui.foreground);
    expect(darkCss).toContain(carbon.ui.accent);
    expect(darkCss).toContain(carbon.syntax.keyword);
    expect(darkCss).toContain("Menlo");
    expect(darkCss).toContain("14px");
    expect(darkCss).toContain("color-scheme: dark");
    const lightCss = buildPreviewThemeCss(paper, { fontSize: 13 });
    expect(lightCss).toContain(paper.ui.background);
    expect(lightCss).toContain(paper.syntax.keyword);
    expect(lightCss).toContain("color-scheme: light");
  });

  test("buildMermaidConfig keeps the worker's theme variables", () => {
    const carbon = getThemeById("industrial-carbon")!;
    const cfg = buildMermaidConfig(carbon, "Menlo") as {
      securityLevel: string;
      theme: string;
      fontFamily: string;
      themeVariables: Record<string, unknown>;
    };
    expect(cfg.theme).toBe("base");
    expect(cfg.fontFamily).toContain("Menlo");
    expect(cfg.fontFamily).toContain("-apple-system");
    expect(cfg.themeVariables.darkMode).toBe(true);
    expect(cfg.themeVariables.background).toBe("transparent");
    expect(cfg.themeVariables.primaryColor).toBe("#232220");
    expect(cfg.themeVariables.primaryTextColor).toBe("#ede8de");
    expect(cfg.themeVariables.primaryBorderColor).toBe("#33312d");
    expect(cfg.themeVariables.lineColor).toBe("#8f897e");
    expect(cfg.themeVariables.secondaryColor).toBe("#1d1c1a");
    expect(cfg.themeVariables.tertiaryColor).toBe("#161514");
    expect(cfg.themeVariables.fontSize).toBe("13px");
  });
});

/** Aed's per-user cache directory (DESIGN.md「术语与边界」), as the app computes it. */
const AED_CACHE_DIR = `${os.homedir()}/Library/Caches/dev.byronwayne.aed`;

describe("I-018 per-user temp files, external open & capabilities", () => {
  test("a name that ends with a space is tried as written before it is trimmed", () => {
    expect(externalFileCandidates("/tmp/notes ").map((c) => c.path)).toEqual(["/tmp/notes ", "/tmp/notes"]);
  });

  test("the queue path is accepted when HOME ends with a slash", async () => {
    // launcher builds it from $HOME as set: `/Users/x/` gives `/Users/x//Library/...`.
    const queue = `${AED_CACHE_DIR.replace("/Library/", "//Library/")}/open-99999991`;
    await withScratch({ "a.txt": "A_FIRST", "q.txt": "Q_SLASHED" }, async ({ app, dir }) => {
      try {
        await runInTerminal(
          app,
          [`rm -rf ${queue}`, `mkdir -p ${queue}`, `printf '%s' '${dir}/q.txt' > ${queue}/1.path`].join(" && "),
          "SLASH_QUEUE_READY"
        );
        const qapp = await open("./App.tsx", {
          platform: "macos",
          width: 1280,
          height: 800,
          host: { params: { openQueue: queue } },
        });
        await qapp.waitFor("id:tab-select-q.txt", { timeout: 4000 });
      } finally {
        await runInTerminal(app, `rm -rf ${queue}`, "SLASH_QUEUE_CLEANED");
      }
    });
  });

  test("file://localhost URLs and %XX escapes decode to the plain path", () => {
    expect(normalizeExternalFilePath("file://localhost/tmp/My%20Notes.md")).toBe("/tmp/My Notes.md");
    expect(normalizeExternalFilePath("file:///tmp/My%20Notes.md#L3")).toBe("/tmp/My Notes.md");
  });

  test("the Mermaid render cache keeps the newest diagrams and revokes the URL of each one it drops", () => {
    const cache = new Map<string, string>();
    const revoked: string[] = [];
    const remember = (key: string) => rememberRender(cache, key, `blob:${key}`, 2, (u) => revoked.push(u));
    remember("a");
    remember("b");
    remember("a"); // used again: now the newest
    remember("c");
    expect([...cache.keys()]).toEqual(["a", "c"]);
    expect(revoked).toEqual(["blob:b"]);
  });

  test("standalone .mmd rendering uses Mermaid's strict security level", () => {
    expect(buildMermaidConfig(getThemeById("industrial-paper")!, "").securityLevel).toBe("strict");
  });

  test(".html previews get a CSP that blocks scripts and remote loads, placed before any of the page's own tags", () => {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'">`;
    expect(withPreviewCsp("<p>hi</p><script>evil()</script>")).toBe(`${csp}<p>hi</p><script>evil()</script>`);
    expect(withPreviewCsp("  <!DOCTYPE html>\n<html><head><script src=https://x.io/a.js></script>")).toBe(
      `  <!DOCTYPE html>${csp}\n<html><head><script src=https://x.io/a.js></script>`
    );
  });

  test("the packaged Info.plist claims Default only for document types, and installing never takes over default apps by itself", async () => {
    // Runs package-macos.sh's own Info.plist step on a throwaway plist, in the app's terminal.
    const script = new URL("./scripts/package-macos.sh", import.meta.url).pathname;
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    const listAnyData =
      `import json,sys; t=[x for x in json.load(sys.stdin) if 'public.data' in x['LSItemContentTypes']]; ` +
      `print('ANYDATA_'+'_'.join(x['CFBundleTypeRole']+x['LSHandlerRank'] for x in t))`;
    await runInTerminal(
      app,
      [
        `D=$(mktemp -d)`,
        `mkdir $D/MacOS`,
        `python3 -I -c "import plistlib,sys; plistlib.dump({}, open(sys.argv[1], 'wb'))" $D/Info.plist`,
        `awk "/<< 'PYEOF'/{f=1;next} /^PYEOF/{f=0} f" ${script} > $D/step.py`,
        `python3 -I $D/step.py $D/Info.plist $D/MacOS`,
        `plutil -extract CFBundleDocumentTypes json -o - $D/Info.plist | python3 -I -c "${listAnyData}"`,
        `echo AUTO_$(grep -c FIRST_INSTALL ${script})`,
        `rm -rf $D`,
      ].join(" && "),
      "PLIST_CHECKED"
    );
    expect(app.texts().some((t) => t.includes("ANYDATA_ViewerAlternate"))).toBe(true);
    expect(app.texts().some((t) => t.includes("AUTO_0"))).toBe(true);
  });

  test("nsh.json grants no network hosts and no remote web pages, and lets the app read its queue path", () => {
    expect(manifest.capabilities.network.hosts).toEqual([]);
    expect(manifest.capabilities.webview.hosts).toEqual([]);
    expect(manifest.capabilities.process.env).toContain("AED_OPEN_QUEUE");
  });

  test("an external open with :line:col jumps there; files named like `odd:2` or with spaces open as named", async () => {
    await withScratch(
      { "a.txt": "A_FIRST", "lines.txt": "L1\\nL2\\nL3 third", "odd:2": "ODD_NAMED" },
      async ({ app, dir }) => {
        await app.host.send("enqueueFinderOpen", `${dir}/lines.txt:3:2`);
        await app.waitUntil(() => app.texts().some((t) => t.includes("Ln 3, Col 2")), {
          timeout: 4000,
        });
        await app.host.send("enqueueFinderOpen", `${dir}/odd:2`);
        await app.waitUntil(() => showsText(app, "ODD_NAMED"), { timeout: 4000 });
        await runInTerminal(app, `printf 'SPACED_NAME\\n' > '${dir}/My Notes.txt'`, "SPACED_DONE");
        await app.host.send("enqueueFinderOpen", `file://localhost${dir}/My%20Notes.txt`);
        await app.waitUntil(() => showsText(app, "SPACED_NAME"), { timeout: 4000 });
      }
    );
  });

  test("the Finder queue is this process's own directory: read in order, entries removed, symlinks never followed", async () => {
    // A pid above macOS's pid_max: no live Aed owns it, and the launcher's cleanup removes it.
    const queue = `${AED_CACHE_DIR}/open-99999990`;
    await withScratch(
      { "a.txt": "A_FIRST", "q1.txt": "Q_ONE", "q2.txt": "Q_TWO", "q10.txt": "Q_TEN", "secret.txt": "SECRET" },
      async ({ app, dir }) => {
        try {
          await runInTerminal(
            app,
            [
              `rm -rf ${queue}`,
              `mkdir -p ${queue}`,
              `printf '%s' '${dir}/q1.txt' > ${queue}/1.path`,
              `printf '%s' '${dir}/q10.txt' > ${queue}/10.path`,
              `printf '%s' '${dir}/q2.txt' > ${queue}/2.path`,
              `printf '%s' '${dir}/secret.txt' > ${dir}/pointer`,
              `ln -s ${dir}/pointer ${queue}/3.path`,
              `printf '%s' '${dir}/secret.txt' > ${queue}/.4.tmp`,
            ].join(" && "),
            "QUEUE_READY"
          );
          const qapp = await open("./App.tsx", {
            platform: "macos",
            width: 1280,
            height: 800,
            host: { params: { openQueue: queue } },
          });
          await qapp.waitFor("id:tab-select-q10.txt", { timeout: 4000 });
          expect(qapp.shows("id:tab-select-q1.txt")).toBe(true);
          expect(qapp.shows("id:tab-select-q2.txt")).toBe(true);
          expect(qapp.shows("id:tab-select-secret.txt")).toBe(false);
          // The last entry (by number, 10 after 2) is the active tab.
          expect(showsText(qapp, "Q_TEN")).toBe(true);
          await runInTerminal(
            app,
            `ls -A ${queue} | grep -v '^\\.' | wc -l | tr -d ' ' | sed 's/^/QLEFT_/'`,
            "QUEUE_COUNTED"
          );
          expect(app.texts().some((t) => t.includes("QLEFT_0"))).toBe(true);
        } finally {
          await runInTerminal(app, `rm -rf ${queue}`, "QUEUE_CLEANED");
        }
      }
    );
  });

  test("PDF previews are made in the per-user cache and the PNG is deleted once read", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:manual.pdf");
    await app.press("text:manual.pdf");
    await app.waitFor("id:preview-quicklook-sheet", { timeout: 8000 });
    await runInTerminal(
      app,
      `test -d ${AED_CACHE_DIR}/ql && ls -A ${AED_CACHE_DIR}/ql | wc -l | tr -d ' ' | sed 's/^/QLPNG_/'`,
      "QL_COUNTED"
    );
    expect(app.texts().some((t) => t.includes("QLPNG_0"))).toBe(true);
  });
});

describe("races and silent failures (I-017)", () => {
  const GIT_COMMIT = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m init";

  test("an AED_ROOT launch adds its folder to Recent and keeps the others", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: { "aed.recentWorkspaces": JSON.stringify(["/r/a", "/r/b"]) },
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    const expected = JSON.stringify([FIXTURE_ROOT, "/r/a", "/r/b"]);
    await app.waitUntil(() => app.storage()["aed.recentWorkspaces"] === expected, { timeout: 3000 });
  });

  test("a slow scan of the folder before never replaces the tree of the folder open now", async () => {
    // `git status` waits ~4 s on the fsmonitor hook: the scan of this folder ends last.
    const { dir, remove } = await makeScratch((d) => [
      `printf 'X\\n' > ${d}/OLD_ONLY.txt`,
      `git -C ${d} init -q`,
      `git -C ${d} config core.fsmonitor 'sleep 2; false'`,
    ]);
    try {
      const app = await open("./App.tsx", {
        platform: "macos",
        width: 1280,
        height: 800,
        host: { params: { workspaceRoot: FIXTURE_ROOT } },
      });
      await app.waitFor("text:main.ts");
      await app.dropFiles("id:app-root", [`file://${dir}`]);
      await app.dropFiles("id:app-root", [`file://${FIXTURE_ROOT}`]);
      await app.waitFor("text:main.ts");
      await app.wait(5000);
      expect(app.shows("text:main.ts")).toBe(true);
      expect(app.shows("text:OLD_ONLY.txt")).toBe(false);
    } finally {
      await remove();
    }
  });

  test("only the newest Mermaid render lands, and each new render shows loading first", async () => {
    const shown: string[] = [];
    let starts = 0;
    const follow = followLatest<string>({
      start: () => (starts += 1),
      done: (v) => shown.push(v),
      fail: (e) => shown.push(`error:${String(e)}`),
    });
    let finishOld: (v: string) => void = () => undefined;
    let failOld: (e: unknown) => void = () => undefined;
    follow(new Promise<string>((resolve) => (finishOld = resolve)));
    follow(Promise.resolve("new"));
    follow(new Promise<string>((_, reject) => (failOld = reject)));
    follow(Promise.resolve("newest"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishOld("old");
    failOld("boom");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(4);
    expect(shown).toEqual(["newest"]);
  });

  test("a deleted file in the Changed list opens its diff", async () => {
    await withScratch(
      { "keep.txt": "KEEP_V1", "gone.txt": "GONE_V1" },
      async ({ app }) => {
        await app.press("id:sidebar-filter-changed");
        await app.waitFor("text:gone.txt");
        await app.press("text:gone.txt");
        await app.waitFor("id:preview-diff");
        expect(app.shows("id:open-error-banner")).toBe(false);
      },
      (dir) => [`git -C ${dir} init -q`, `git -C ${dir} add -A`, `git -C ${dir} ${GIT_COMMIT}`, `rm ${dir}/gone.txt`]
    );
  });

  test("a Finder open that fails keeps the folder and says why", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT, openFile: `${SCRATCH_RUN}-missing/nope.md` } },
    });
    await app.waitFor("id:open-error-banner");
    expect(app.shows("id:workspace-tree")).toBe(true);
    expect(app.texts().some((t) => t.includes("nope.md"))).toBe(true);
    await app.press("id:open-error-dismiss-btn");
    expect(app.shows("id:open-error-banner")).toBe(false);
  });

  test("a link or drop to a missing file says it cannot be opened", async () => {
    // A Markdown link and a drop both end in the same tab open (the WebView click
    // itself cannot be driven headless).
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await app.dropFiles("id:app-root", [`file://${SCRATCH_RUN}-missing/link.md`]);
    await app.waitFor("id:open-error-banner");
    expect(app.texts().some((t) => t.includes("link.md"))).toBe(true);
    // The next good open clears it.
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    expect(app.shows("id:open-error-banner")).toBe(false);
  });

  test("⌘0 resets the font size and keeps the font family", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: { "aed.fontFamily": "Menlo", "aed.fontSize": "16" },
    });
    await app.keyboard.press("mod+,");
    await app.waitFor("text:16px");
    await app.keyboard.press("mod+0");
    await app.waitFor("text:13px");
    expect(app.storage()["aed.fontSize"]).toBe("13");
    expect(app.storage()["aed.fontFamily"]).toBe("Menlo");
  });

  test("the find bar belongs to the editor: hidden on previews, closed by Escape, not opened from the terminal", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await app.press("text:README.md");
    await app.waitFor("id:preview-markdown");
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    await app.keyboard.press("mod+f");
    await app.waitFor("id:editor-find-input");
    // Escape in the find field closes it and hands the keys back to the editor.
    await app.type("id:editor-find-input", "main");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:editor-find-input"), { timeout: 2000 });
    await app.keyboard.press("mod+f");
    await app.waitFor("id:editor-find-input");
    // A preview tab has no find bar; back on the editor it is there to close with ⌘F.
    await app.press("id:tab-select-README.md");
    await app.waitFor("id:preview-markdown");
    expect(app.shows("id:editor-find-input")).toBe(false);
    await app.press("id:tab-select-main.ts");
    await app.waitFor("id:editor-find-input");
    await app.keyboard.press("mod+f");
    await app.waitUntil(() => !app.shows("id:editor-find-input"), { timeout: 2000 });
    // ⌘F while the terminal has the keyboard is the terminal's.
    await runInTerminal(app, "true", "FIND_TERM");
    await termTest(app, { type: "focus", focused: true });
    await app.keyboard.press("mod+f");
    await app.wait(200);
    expect(app.shows("id:editor-find-input")).toBe(false);
  });

  test("dropping several files opens each of them", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:main.ts");
    await app.dropFiles("id:app-root", [
      `file://${FIXTURE_ROOT}/main.ts`,
      `file://${FIXTURE_ROOT}/guide.md`,
    ]);
    await app.waitFor("id:tab-select-main.ts");
    await app.waitFor("id:tab-select-guide.md");
  });

  test("CSV quoted line breaks, number cells and JSONL bad lines", () => {
    const csv = parseTableData('name,note,n\nA,"line1\nline2", 42 \nB,x,007\n', "t.csv");
    expect(csv.rows).toEqual([
      ["A", "line1\nline2", 42],
      ["B", "x", "007"],
    ]);
    expect(csv.invalidLines).toEqual([]);
    const jsonl = parseTableData('{"a":1}\nnot json\n\n[1]\n{"a":2}\n', "t.jsonl");
    expect(jsonl.rows).toEqual([[1], [2]]);
    expect(jsonl.invalidLines).toEqual([2, 4]);
  });

  test("a column of numbers and text sorts the same from any order", () => {
    const columns = [{ key: "0", title: "v" }];
    const asc = { key: "0", direction: "ascending" as const };
    const orders = [[2], [10], ["1a"], ["b"]];
    const permutations = [orders, [...orders].reverse(), [orders[2], orders[0], orders[3], orders[1]]];
    for (const rows of permutations) {
      expect(sortRows(rows, columns, asc).map((r) => r[0])).toEqual([2, 10, "1a", "b"]);
    }
  });

  test("a table starts fresh after another table: its own columns, no sort carried over", async () => {
    // The sort itself cannot be pressed headless (the header is drawn natively); both
    // live in the table, which now starts again for each file.
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.waitFor("text:events.jsonl");
    await app.press("text:events.jsonl");
    await app.waitFor("text:boot");
    await app.press("text:metrics.csv");
    await app.waitFor("text:api-gateway");
    expect(showsText(app, "latency_ms")).toBe(true);
    expect(showsText(app, "event")).toBe(false);
  });

  test("a file above 8 MB opens read-only from its first bytes; a large binary shows its first 4 KB", async () => {
    await withScratch(
      { "note.txt": "NOTE_V1" },
      async ({ app }) => {
        await app.press("text:big.txt");
        await app.waitFor("id:read-only-banner", { timeout: 8000 });
        expect(app.texts().some((t) => t.includes("8 MB"))).toBe(true);
        await app.press("text:big.dat");
        await app.waitFor("id:preview-hex", { timeout: 8000 });
      },
      (dir) => [
        `python3 -c "open('${dir}/big.txt','w').write(('BIG_LINE '+'x'*1000+chr(10))*8600)"`,
        `dd if=/dev/zero of=${dir}/big.dat bs=1048576 count=9 2>/dev/null`,
      ]
    );
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
});

describe("terminal: libghostty-vt sessions & the PTY (I-019)", () => {
  test("every theme maps to a terminal theme whose 16 ANSI colours read on its background", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const theme of EDITOR_THEMES) {
      expect(ANSI_PALETTES[theme.id]).toBeDefined();
      const x = buildTerminalTheme(theme);
      expect(x.background).toBe(theme.ui.background);
      expect(x.foreground).toBe(theme.ui.foreground);
      expect(x.cursor).toBe(theme.ui.accent);
      expect(x.selection).toBe(theme.ui.selection);
      expect(x.palette).toHaveLength(16);
      expect(contrast(x.foreground, x.background)).toBeGreaterThanOrEqual(4.5);
      ANSI_NAMES.forEach((name, i) => {
        expect(x.palette[i]).toMatch(/^#[0-9a-f]{6}$/);
        // Black is the background colour of dark themes; everything else is text.
        if (name === "black" && theme.appearance === "dark") return;
        expect(contrast(x.palette[i], x.background)).toBeGreaterThanOrEqual(3);
      });
    }
    // A theme without a palette of its own takes its syntax colours.
    const custom = { ...EDITOR_THEMES[1], id: "custom-dark" };
    const ansi = (name: string) => ANSI_NAMES.indexOf(name as (typeof ANSI_NAMES)[number]);
    const derived = buildTerminalTheme(custom).palette;
    expect(derived[ansi("red")]).toBe(custom.syntax.keyword);
    expect(derived[ansi("green")]).toBe(custom.syntax.string);
    expect(derived[ansi("brightBlack")]).toBe(custom.ui.mutedForeground);
    expect(derived[ansi("brightRed")]).toBe(custom.syntax.keyword);
    expect(derived[ansi("black")]).toBe(custom.ui.card);
    const light = EDITOR_THEMES.find((t) => t.appearance === "light")!;
    expect(buildTerminalTheme({ ...light, id: "custom-light" }).palette[ansi("black")]).toBe(light.ui.foreground);
    expect(derived.every((colour) => typeof colour === "string")).toBe(true);
  });

  test("a ⌘-clicked word opens as a web link or a file relative to the shell's folder", () => {
    expect(linkTarget("https://example.com/a?b=1", "/w", "/h")).toEqual({ url: "https://example.com/a?b=1" });
    expect(linkTarget("src/a.ts:12:3", "/w", "/h")).toEqual({ file: "/w/src/a.ts" });
    expect(linkTarget("src/a.ts:12", "/w", "/h")).toEqual({ file: "/w/src/a.ts" });
    expect(linkTarget("~/notes.md", "/w", "/h")).toEqual({ file: "/h/notes.md" });
    expect(linkTarget("/etc/hosts", "/w", "/h")).toEqual({ file: "/etc/hosts" });
    expect(linkTarget("ftp://x", "/w", "/h")).toEqual({ file: "/w/ftp:/x" });
  });

  // The PTY, through the app's own terminal (a test file cannot spawn processes).
  test("a resize reaches the shell as its terminal size", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "stty size", "SIZE_FIRST");
    expect(showsText(app, "32 140")).toBe(true); // DEFAULT_ROWS × DEFAULT_COLS until the view measures
    await termTest(app, { type: "resize", rows: 40, cols: 120 });
    await runInTerminal(app, "stty size", "SIZE_AFTER");
    expect(showsText(app, "40 120")).toBe(true);
  });

  test("Ctrl-C interrupts a running command", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "true", "SHELL_UP");
    await termType(app, "sleep 30\r");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await termType(app, "\u0003");
    await runInTerminal(app, "true", "AFTER_INTERRUPT"); // within 8 s, not after sleep's 30
  });

  test("UTF-8 split across writes and across PTY reads arrives whole", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "true", "SHELL_UP");
    const bytes = new TextEncoder().encode("echo 中文字符_OK\r");
    const cut = bytes.indexOf(0xe4) + 1; // inside 中
    const binary = (b: Uint8Array) => String.fromCharCode(...b);
    await termTest(app, { type: "input", data: binary(bytes.slice(0, cut)), binary: true });
    await termTest(app, { type: "input", data: binary(bytes.slice(cut)), binary: true });
    await app.waitUntil(() => showsText(app, "中文字符_OK"), { timeout: 8000 });
    // 9000 bytes of output: the PTY hands them over in reads that cut characters.
    await runInTerminal(app, "printf '中%.0s' $(seq 1 3000); echo", "CJK_DONE");
    expect(showsText(app, "中".repeat(3000))).toBe(true);
    expect(app.texts().some((t) => t.includes("\ufffd"))).toBe(false);
  });

  test("while the terminal has the keyboard, ⌘K clears it and ⌘F opens no find bar", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });
    await app.press("text:main.ts");
    await app.waitFor("id:preview-editor");
    await runInTerminal(app, "true", "CLEAR_ME");
    await termTest(app, { type: "focus", focused: true });
    await app.keyboard.press("mod+f");
    await app.keyboard.press("mod+k");
    expect(app.shows("id:editor-find-input")).toBe(false);
    expect(app.shows("id:command-palette")).toBe(false);
    expect(showsText(app, "CLEAR_ME")).toBe(false);
    // Once it lost the keyboard, the shortcuts are the app's again.
    await termTest(app, { type: "focus", focused: false });
    await app.keyboard.press("mod+f");
    await app.waitFor("id:editor-find-input");
    await app.keyboard.press("mod+k");
    await app.waitFor("id:command-palette");
  });

  test("picking another shell keeps a used session and opens the new shell in a new tab", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1280, height: 800 });
    await runInTerminal(app, "true", "USED_SHELL");
    const firstTitle = app.texts().find((t) => t.startsWith("1: "));
    expect(firstTitle).toBeDefined();
    await app.press("id:terminal-shell-trigger");
    await app.press("id:shell-option-sh");
    await app.waitFor("text:2: sh");
    expect(showsText(app, firstTitle!)).toBe(true);
    await runInTerminal(app, "echo $0", "IN_NEW_TAB");
    expect(app.texts().some((t) => /^-?sh$/.test(t))).toBe(true);
    await app.press(`text:${firstTitle}`);
    await app.waitUntil(() => showsText(app, "USED_SHELL"), { timeout: 3000 });
  });
});
