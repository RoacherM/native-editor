import { describe, expect, open, test } from "nsh/test";
import * as markdownPreviewMod from "./MarkdownPreview";
import * as mermaidMod from "./mermaid";
import { createLruCache } from "./classify";
import {
  buildPreloadBgScript,
  buildPreviewRenderScript,
  planPreviewRender,
  readImageDataUrl,
  type ImageReadIo,
  type PreviewRenderTracker,
} from "./MarkdownPreview";
import {
  buildMermaidConfig,
  clampDiagramZoom,
  detectMermaidKind,
  extractInlineMermaidFromHtml,
  findMermaidBundleJs,
  formatDiagramRenderMessage,
  formatDiagramZoomScript,
  formatThemeSyncScript,
  getPreviewShellHtml,
  hasCachedPreviewShellHtml,
  preprocessMermaidCode,
  type ExtensionScanIo,
} from "./mermaid";
import { getThemeById } from "./themes";

describe("Mermaid & unified preview host pure contracts", () => {
  test("lazy preview shell HTML avoids import-time allocation and caches once built", () => {
    expect(hasCachedPreviewShellHtml()).toBe(false);
    const first = getPreviewShellHtml();
    expect(hasCachedPreviewShellHtml()).toBe(true);
    expect(first).toContain('meta http-equiv="Content-Security-Policy"');
    expect(first).not.toContain("<script");
    expect(getPreviewShellHtml()).toBe(first);
  });

  test("offscreen rasterizer, compat shims, and CDN URLs are completely removed", () => {
    expect("MermaidRendererHost" in mermaidMod).toBe(false);
    expect("MermaidDiagramBlock" in mermaidMod).toBe(false);
    expect("requeueOrphanedJobs" in mermaidMod).toBe(false);
    expect("requestMermaidRender" in mermaidMod).toBe(false);
    expect("buildWorkerHtml" in mermaidMod).toBe(false);

    const compiledSources = [
      ...Object.values(mermaidMod).map(String),
      ...Object.values(markdownPreviewMod).map(String),
    ].join("\n");

    expect(compiledSources).toContain("renderDiagram");
    expect(compiledSources).toContain("aed-diagram-only");

    const forbiddenUrl = ["https:", "", "cdn."].join("/");
    expect(compiledSources.includes(forbiddenUrl)).toBe(false);
    expect(compiledSources.includes("jsdelivr")).toBe(false);
    expect(compiledSources.includes("buildWorkerHtml")).toBe(false);
    expect(compiledSources.includes("inlineForeignObjects")).toBe(false);
    expect(compiledSources.includes("rasterizeSvgToPng")).toBe(false);
    expect(compiledSources.includes("-10000")).toBe(false);
  });

  test("buildPreloadBgScript paints theme background before content load to prevent white flash", () => {
    const script = buildPreloadBgScript("#161514");
    expect(script).toContain('document.documentElement.style.background="#161514"');
    expect(script).toContain("document.body.style.background='transparent'");
  });

  test("detectMermaidKind extracts diagram headers and falls back to lowercase mermaid", () => {
    expect(detectMermaidKind("%% lead comment\n\n  flowchart LR\n  A --> B")).toBe("flowchart LR");
    expect(detectMermaidKind("graph TD\n  A --> B")).toBe("graph TD");
    expect(detectMermaidKind("sequenceDiagram\n  Alice->>Bob: Hi")).toBe("sequenceDiagram");
    expect(detectMermaidKind("stateDiagram-v2\n  [*] --> Idle")).toBe("stateDiagram-v2");
    expect(detectMermaidKind("erDiagram\n  USER ||--o{ ORDER : places")).toBe("erDiagram");
    expect(detectMermaidKind("xychart-beta\n  line [1, 2, 3]")).toBe("xychart-beta");
    expect(detectMermaidKind("unknownHeader\n  foo")).toBe("mermaid");
    expect(detectMermaidKind("   \n  %% only comment  ")).toBe("mermaid");
  });

  test("preprocessMermaidCode normalizes escaped newlines and multiline double-quoted labels", () => {
    expect(
      preprocessMermaidCode('  flowchart TB\n  A["first\r\n    second\\nthird"] --> B["ok"]  '),
    ).toBe('flowchart TB\n  A["first<br/>second<br/>third"] --> B["ok"]');
  });

  test("buildMermaidConfig enforces strict security and maps light and dark theme palettes", () => {
    const paper = getThemeById("industrial-paper")!;
    const carbon = getThemeById("industrial-carbon")!;

    const lightCfg = buildMermaidConfig(paper, "");
    expect(lightCfg.securityLevel).toBe("strict");
    expect(lightCfg.startOnLoad).toBe(false);
    expect(lightCfg.theme).toBe("base");
    expect(lightCfg.fontFamily.startsWith("-apple-system")).toBe(true);
    expect(lightCfg.themeVariables.darkMode).toBe(false);
    expect(lightCfg.themeVariables.primaryTextColor).toBe(paper.ui.foreground);

    const darkCfg = buildMermaidConfig(carbon, "JetBrains Mono");
    expect(darkCfg.securityLevel).toBe("strict");
    expect(darkCfg.fontFamily.startsWith("JetBrains Mono, -apple-system")).toBe(true);
    expect(darkCfg.themeVariables.darkMode).toBe(true);
    expect(darkCfg.themeVariables.primaryColor).toBe(carbon.ui.card);
    expect(darkCfg.themeVariables.primaryTextColor).toBe(carbon.ui.foreground);
  });

  test("formatDiagramRenderMessage, buildPreviewRenderScript, and formatDiagramZoomScript match page.mjs contract", () => {
    const carbon = getThemeById("industrial-carbon")!;
    const msg = formatDiagramRenderMessage({
      renderId: 7,
      path: "/ws/arch.mmd",
      code: "flowchart TB\nA-->B",
      themeCss: "body{background:#161514}",
      theme: carbon,
    });
    expect(msg).toEqual({
      type: "renderDiagram",
      renderId: 7,
      path: "/ws/arch.mmd",
      code: "flowchart TB\nA-->B",
      themeCss: "body{background:#161514}",
      mermaidConfig: buildMermaidConfig(carbon, ""),
    });

    expect(clampDiagramZoom(10)).toBe(50);
    expect(clampDiagramZoom(400)).toBe(250);
    expect(clampDiagramZoom(125)).toBe(125);

    const resetJs = formatDiagramZoomScript(100);
    expect(resetJs).toContain("aed-diagram-only");
    expect(resetJs).toContain('""');

    const zoomedJs = formatDiagramZoomScript(150);
    expect(zoomedJs).toContain('"1.5"');

    const mmdScript = buildPreviewRenderScript({
      file: {
        path: "/ws/arch.mmd",
        text: "graph LR\nA-->B",
        classification: {
          kind: "mermaid",
          language: "mermaid",
          defaultMode: "preview",
          mimeType: "text/vnd.mermaid",
        },
      },
      renderId: 3,
      themeCss: "body{}",
      theme: carbon,
      zoomPercent: 125,
      scrollY: 0,
    });
    expect(mmdScript).toContain('document.documentElement.style.background=""');
    expect(mmdScript).toContain("window.__aed.renderDiagram(");
    expect(mmdScript).toContain('"1.25"');

    const mdScript = buildPreviewRenderScript({
      file: {
        path: "/ws/README.md",
        text: "# Title",
        classification: {
          kind: "markdown",
          language: "markdown",
          defaultMode: "preview",
          mimeType: "text/markdown",
        },
      },
      renderId: 4,
      themeCss: "body{}",
      theme: carbon,
      zoomPercent: 175,
      scrollY: 48,
    });
    expect(mdScript).toContain('document.documentElement.style.background=""');
    expect(mdScript).toContain("window.__aed.render(");
    expect(mdScript).toContain('"scrollY":48');
    expect(mdScript).not.toContain('"1.75"');

    const themeScript = formatThemeSyncScript("body{color:#fff}", buildMermaidConfig(carbon, ""));
    expect(themeScript).toContain('document.documentElement.style.background=""');
    expect(themeScript).toContain("window.__aed.setTheme(");
  });

  test("DiagramViewportPill renders numeric zoom percentage, updates to 125%, and hides when switching to Code mode", async () => {
    const archPath = decodeURIComponent(
      new URL("../fixtures/architecture.mmd", import.meta.url).pathname,
    );
    const app = await open("../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { openFile: archPath } },
    });
    await app.waitFor("id:mermaid-zoom-reset");
    expect(app.shows("text:100%")).toBe(true);
    expect(app.shows("id:mermaid-toggle-code")).toBe(false);

    await app.press("id:mermaid-zoom-in");
    expect(app.shows("text:125%")).toBe(true);

    await app.press("id:mermaid-zoom-reset");
    expect(app.shows("text:100%")).toBe(true);

    await app.press("id:mode-source");
    await app.waitFor("id:preview-editor");
    expect(app.shows("id:mermaid-zoom-in")).toBe(false);
    expect(app.shows("id:mermaid-zoom-reset")).toBe(false);
  });

  test("extractInlineMermaidFromHtml and findMermaidBundleJs slice bundle cleanly and skip broken entries", async () => {
    const startMarker = "var __esbuild_esm_mermaid_nm;";
    const endMarker =
      'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;';
    const fakeHtml = `<html><body><script>${startMarker}window.ok=1;${endMarker}</script></body></html>`;

    const sliced = extractInlineMermaidFromHtml(fakeHtml);
    expect(sliced).toBe(`${startMarker}window.ok=1;${endMarker}`);
    expect(extractInlineMermaidFromHtml("<html>no markers</html>")).toBeNull();

    const files = new Map<string, string>([
      ["/ext/xicilion.markdown-viewer-extension-1.0.0/webview/iframe-render.html", fakeHtml],
    ]);
    const io: ExtensionScanIo = {
      readdir: async (dirPath) => {
        if (dirPath === "/ext") {
          return [
            "other.extension-1.0.0",
            "xicilion.markdown-viewer-extension-1.0.0",
            "xicilion.markdown-viewer-extension-1.2.0",
          ];
        }
        throw new Error("ENOENT");
      },
      readFileUtf8: async (filePath) => {
        const val = files.get(filePath);
        if (val === undefined) throw new Error("ENOENT");
        return val;
      },
    };

    const found = await findMermaidBundleJs(["/missing", "/ext"], io);
    expect(found).toBe(`${startMarker}window.ok=1;${endMarker}`);
  });

  test("planPreviewRender skips non-preview keystrokes and renders immediately on path or mode transitions", () => {
    const tracker: PreviewRenderTracker = { active: false, path: "", kind: "" };

    expect(
      planPreviewRender(tracker, {
        path: "/ws/App.tsx",
        mode: "source",
        classification: { kind: "code", language: "tsx", defaultMode: "source", mimeType: "text/plain" },
      }),
    ).toBe("skip");
    expect(
      planPreviewRender(tracker, {
        path: "/ws/README.md",
        mode: "source",
        classification: { kind: "markdown", language: "markdown", defaultMode: "preview", mimeType: "text/markdown" },
      }),
    ).toBe("skip");

    const mdPreview = {
      path: "/ws/README.md",
      mode: "preview" as const,
      classification: { kind: "markdown" as const, language: "markdown", defaultMode: "preview" as const, mimeType: "text/markdown" },
    };
    expect(planPreviewRender(tracker, mdPreview)).toBe("immediate");
    expect(planPreviewRender(tracker, mdPreview)).toBe("debounce");

    expect(
      planPreviewRender(tracker, {
        path: "/ws/arch.mmd",
        mode: "preview",
        classification: { kind: "mermaid", language: "mermaid", defaultMode: "preview", mimeType: "text/vnd.mermaid" },
      }),
    ).toBe("immediate");

    expect(
      planPreviewRender(tracker, {
        path: "/ws/arch.mmd",
        mode: "source",
        classification: { kind: "mermaid", language: "mermaid", defaultMode: "preview", mimeType: "text/vnd.mermaid" },
      }),
    ).toBe("skip");
    expect(
      planPreviewRender(tracker, {
        path: "/ws/arch.mmd",
        mode: "preview",
        classification: { kind: "mermaid", language: "mermaid", defaultMode: "preview", mimeType: "text/vnd.mermaid" },
      }),
    ).toBe("immediate");
  });

  test("readImageDataUrl caches Base64 data URLs by path and stat stamp in LRU and invalidates on file change", async () => {
    const cache = createLruCache<string, string>(4);
    let statCalls = 0;
    let readCalls = 0;
    let currentMtime = 1000;
    let currentBytes = new Uint8Array([137, 80, 78, 71]);

    const io: ImageReadIo = {
      stat: async () => {
        statCalls += 1;
        return {
          isFile: () => true,
          mtimeMs: currentMtime,
          size: currentBytes.byteLength,
        };
      },
      readFile: async () => {
        readCalls += 1;
        return currentBytes;
      },
    };

    const first = await readImageDataUrl("/ws/dot.png", cache, io);
    expect(first).toBe("data:image/png;base64,iVBORw==");
    expect(statCalls).toBe(1);
    expect(readCalls).toBe(1);

    const second = await readImageDataUrl("/ws/dot.png", cache, io);
    expect(second).toBe(first);
    expect(statCalls).toBe(2);
    expect(readCalls).toBe(1);

    currentMtime = 2000;
    currentBytes = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const third = await readImageDataUrl("/ws/dot.png", cache, io);
    expect(third).toBe("data:image/png;base64,iVBORw0K");
    expect(readCalls).toBe(2);

    expect(await readImageDataUrl("/ws/notes.md", cache, io)).toBeNull();
    expect(statCalls).toBe(3);
  });
});
