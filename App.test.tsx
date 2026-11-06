import { describe, expect, open, test } from "nsh/test";
import {
  classifyFile,
  formatHexDump,
  parseTableData,
  probeImageDimensions,
} from "./src/classify";
import { detectMermaidKind, preprocessMermaidCode } from "./src/mermaid";
import { parseGhosttyConfig } from "./src/TerminalPane";
import manifest from "./nsh.json";
import {
  computeSyntaxDecorations,
  EDITOR_THEMES,
  getThemeById,
} from "./src/themes";

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

  test("enforces least-privilege process.execute allowlist in nsh.json", () => {
    expect(manifest.capabilities.process.execute).toEqual([
      "git",
      "python3",
      "sips",
      "osascript",
    ]);
  });
});

describe("Native Editor E2E desktop UI, multimedia preview & Ghostty terminal", () => {
  test("clean launch without workspace hides file tree and shows clean welcome panel", async () => {
    const cleanApp = await open("./App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
    });
    await cleanApp.waitFor("id:welcome-panel");
    expect(cleanApp.shows("id:welcome-panel")).toBe(true);
    expect(cleanApp.shows("id:workspace-tree")).toBe(false);
    expect(cleanApp.shows("id:theme-preset-tokyo-night")).toBe(false);
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

    // 8. Multimedia: PDF Quick Look preview
    await app.press("text:manual.pdf");
    await app.waitFor("id:preview-quicklook");
    expect(app.shows("id:preview-quicklook")).toBe(true);

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
});
