import { describe, expect, open, test } from "nsh/test";
import {
  classifyFile,
  formatHexDump,
  normalizeMachOBuildVersion,
  parseTableData,
  probeImageDimensions,
} from "./src/classify";
import { detectMermaidKind, preprocessMermaidCode } from "./src/mermaid";
import { parseGhosttyConfig } from "./src/TerminalPane";
import manifest from "./nsh.json";
import {
  computeSyntaxDecorations,
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  fontDisplayName,
  getThemeById,
} from "./src/themes";
import { shortenHomePath } from "./src/workspace";

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
    const csv = parseTableData("name,score\nAlice,95\nBob,88\n", "scores.csv");
    expect(csv.columns).toHaveLength(2);
    expect(csv.columns[0].title).toBe("name");
    expect(csv.rows).toEqual([
      ["Alice", 95],
      ["Bob", 88],
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

    const tsDecos = computeSyntaxDecorations(
      'export function greet(name: string): string {\n  // hello\n  return "hi";\n}',
      "typescript",
      tokyo.syntax
    );
    expect(tsDecos.length).toBeGreaterThanOrEqual(5);
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
    expect(cleanApp.shows("text:⌘O")).toBe(false);
    expect(cleanApp.shows("text:Tokyo Night")).toBe(true);
    expect(cleanApp.shows("id:workspace-tree")).toBe(false);
    expect(cleanApp.shows("id:theme-preset-tokyo-night")).toBe(false);
    expect(cleanApp.shows("text:main")).toBe(false);

    // Shrinking viewport below minimum window dimensions must not crush the poster grid
    await cleanApp.setViewport(280, 450);
    expect(cleanApp.spanStyle("text:Aed").fontSize).toBeGreaterThanOrEqual(56);

    // Subsequent launches with saved recentWorkspaces auto-restore workspace without showing poster
    const returningApp = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "aed.recentWorkspaces": JSON.stringify([FIXTURE_ROOT]),
      },
    });
    await returningApp.waitFor("id:empty-editor-panel");
    expect(returningApp.shows("id:welcome-panel")).toBe(false);
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

    // 12. Theme toggle (Dark <-> Light), Statusbar Theme Select popup & Font Family/Size configuration
    await app.press("id:titlebar-toggle-theme");
    await app.press("id:titlebar-toggle-theme");

    await app.press("id:statusbar-theme-trigger");
    await app.waitFor("id:theme-option-tokyo-night");
    expect(app.shows("id:theme-option-tokyo-night")).toBe(true);
    await app.press("id:theme-option-tokyo-night");
    expect(app.shows("text:Tokyo Night")).toBe(true);

    // Status-bar font badge opens a plain font list, not the Preferences dialog
    await app.press("id:statusbar-font-trigger");
    await app.waitFor("id:font-option-Menlo");
    expect(app.shows("id:font-settings-dialog")).toBe(false);
    await app.press("id:font-option-Menlo");
    await app.waitFor("text:Menlo · 14px");

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
});
