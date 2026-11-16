import { describe, expect, test } from "nsh/test";
import * as markdownPageMod from "./markdownPage";
import {
  buildPreviewShellHtml,
  buildPreviewThemeCss,
  classifyPreviewLink,
  handlePreviewMessage,
  imageMimeForPath,
  parsePreviewMessage,
  resolvePreviewImagePath,
  type PreviewBridgeDeps,
} from "./markdownPage";
import { MARKDOWN_RUNTIME_JS } from "./markdownVendor.generated";
import { getThemeById } from "./themes";

describe("markdownPage target routing, image MIME & CSS spine", () => {
  test("removed dead isExternalOrHashUrl and resolveRelativeLink exports", () => {
    expect("isExternalOrHashUrl" in markdownPageMod).toBe(false);
    expect("resolveRelativeLink" in markdownPageMod).toBe(false);
    expect(imageMimeForPath("/tmp/diagram.svg")).toBe("image/svg+xml");
  });

  test("classifyPreviewLink delegates to parseTarget, fixing file://localhost/ and preserving line/column", () => {
    const base = "/ws/docs/guide.md";

    expect(classifyPreviewLink("https://example.com/x", base)).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(classifyPreviewLink("mailto:a@b.c", base)).toEqual({
      kind: "external",
      url: "mailto:a@b.c",
    });
    expect(classifyPreviewLink("javascript:alert(1)", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("data:text/html,x", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("ssh://host/x", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("x-apple.systempreferences:", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("#frag", base)).toEqual({ kind: "none" });
    expect(classifyPreviewLink("file://otherhost/tmp/x.md", base)).toEqual({ kind: "none" });

    // Plain file links omit line/column when 0.
    expect(classifyPreviewLink("./b.md#x", base)).toEqual({
      kind: "file",
      path: "/ws/docs/b.md",
    });
    expect(classifyPreviewLink("file://localhost/tmp/My%20Notes.md", base)).toEqual({
      kind: "file",
      path: "/tmp/My Notes.md",
    });

    // Line & column suffixes preserved cleanly.
    expect(classifyPreviewLink("../b.md#L9", base)).toEqual({
      kind: "file",
      path: "/ws/b.md",
      line: 9,
    });
    expect(classifyPreviewLink("./a.ts#L42C7", base)).toEqual({
      kind: "file",
      path: "/ws/docs/a.ts",
      line: 42,
      column: 7,
    });
    expect(classifyPreviewLink("./a.ts:12:3", base)).toEqual({
      kind: "file",
      path: "/ws/docs/a.ts",
      line: 12,
      column: 3,
    });
    expect(classifyPreviewLink("file://localhost/tmp/c%23sharp.md#L15", base)).toEqual({
      kind: "file",
      path: "/tmp/c#sharp.md",
      line: 15,
    });
  });

  test("resolvePreviewImagePath uses parseTarget + imageMimeForPath (supporting file://localhost and .heic)", () => {
    const base = "/ws/docs/guide.md";
    expect(resolvePreviewImagePath("poster.png", base)).toBe("/ws/docs/poster.png");
    expect(resolvePreviewImagePath("file://localhost/tmp/shot.heic", base)).toBe("/tmp/shot.heic");
    expect(resolvePreviewImagePath("c%23diagram.svg?v=2#layer", base)).toBe(
      "/ws/docs/c#diagram.svg",
    );
    expect(resolvePreviewImagePath("p.PNG", base)).toBe("/ws/docs/p.PNG");
    expect(resolvePreviewImagePath("https://x.io/p.png", base)).toBeNull();
    expect(resolvePreviewImagePath("data:image/png;base64,AA", base)).toBeNull();
    expect(resolvePreviewImagePath("file://otherhost/p.png", base)).toBeNull();
    expect(resolvePreviewImagePath("notes.md", base)).toBeNull();
  });

  test("buildPreviewThemeCss places #aed-toc scrollbar at right:0 with 196px width + 16px right padding and 960-1120px responsive rules", () => {
    const carbon = getThemeById("industrial-carbon")!;
    const css = buildPreviewThemeCss(carbon, { fontFamily: "Menlo", fontSize: 13 });
    expect(buildPreviewShellHtml()).not.toContain("<script");
    expect(css).toContain("right: 0;");
    expect(css).toContain("padding-right: 16px;");
    expect(css).toContain("width: 196px;");
    expect(css).not.toContain("right: 24px;");
    expect(css).toContain("@media (max-width: 1120px)");
    expect(css).toContain("body.aed-diagram-only");
  });

  test("buildPreviewThemeCss applies editorial 760px measure, dynamic font scaling, h1-only border, framed pre/copy pill, clean tables, alert cards, and TOC rail", () => {
    const carbon = getThemeById("industrial-carbon")!;
    const css14 = buildPreviewThemeCss(carbon, { fontFamily: "Menlo", fontSize: 14 });

    // 1. Antialiased body, 760px prose measure, 44/52/96 padding, 15px at fontSize=14, 1.72 leading, -0.006em tracking.
    expect(css14).toContain("-webkit-font-smoothing: antialiased;");
    expect(css14).toContain("max-width: 760px;");
    expect(css14).not.toContain("max-width: 860px;");
    expect(css14).toContain("padding: 44px 52px 96px;");
    expect(css14).toContain("font-size: 15px;");
    expect(css14).toContain("line-height: 1.72;");
    expect(css14).toContain("letter-spacing: -0.006em;");

    // Smooth scaling with ⌘=/⌘- while clamping minimum prose size at 14px.
    const css17 = buildPreviewThemeCss(carbon, { fontFamily: "Menlo", fontSize: 17 });
    expect(css17).toContain("font-size: 18px;");
    expect(css17).toContain("font-size: 17px;");
    const css11 = buildPreviewThemeCss(carbon, { fontFamily: "Menlo", fontSize: 11 });
    expect(css11).toContain("font-size: 14px;");

    // 2. Refined headings: tight optical tracking, border-bottom ONLY on h1, explicitly removed on h2.
    expect(css14).toContain("letter-spacing: -0.024em;");
    expect(css14).toContain("letter-spacing: -0.018em;");
    expect(css14).toContain("letter-spacing: -0.012em;");
    expect(css14).toMatch(/\.markdown-body h1\s*\{[^}]*border-bottom:\s*1px solid/);
    expect(css14).toMatch(/\.markdown-body h2\s*\{[^}]*border-bottom:\s*none/);

    // 3. Framed inline code, pre block, and floating .aed-copy pill.
    expect(css14).toMatch(/\.markdown-body code\s*\{[^}]*border:\s*1px solid #33312d88/);
    expect(css14).toMatch(/\.markdown-body pre\s*\{[^}]*border:\s*1px solid #33312d/);
    expect(css14).toMatch(/\.markdown-body pre \.aed-copy\s*\{[^}]*background:\s*#232220;[^}]*border:\s*1px solid #33312d/);

    // 4. Rounded borderless-vertical tables & GFM callout cards.
    expect(css14).toMatch(/\.markdown-body table\s*\{[^}]*border-collapse:\s*separate/);
    expect(css14).toContain("border-bottom: 1px solid #33312d80;");
    expect(css14).toMatch(/\.markdown-body \.markdown-alert\s*\{[^}]*border-left-width:\s*3px/);

    // 5. Continuous 1px TOC vertical rail + 2px accent active indicator.
    expect(css14).toMatch(/\.aed-toc-list\s*\{[^}]*border-left:\s*1px solid #33312d80/);
    expect(css14).toMatch(/\.aed-toc-item\s*\{[^}]*font-size:\s*12\.5px/);
    expect(css14).toMatch(/\.aed-toc-item\.aed-toc-current\s*\{[^}]*font-weight:\s*500;[^}]*border-left:\s*2px solid #e8462b/);
  });

  test("parsePreviewMessage and handlePreviewMessage support diagramRendered, copySource, and file line locations", async () => {
    expect(parsePreviewMessage('{"type":"diagramRendered","ok":true}')).toEqual({
      type: "diagramRendered",
      ok: true,
    });
    expect(
      parsePreviewMessage('{"type":"diagramRendered","ok":false,"error":"Syntax error"}'),
    ).toEqual({
      type: "diagramRendered",
      ok: false,
      error: "Syntax error",
    });
    expect(parsePreviewMessage('{"type":"diagramRendered","ok":"nope"}')).toBeNull();
    expect(parsePreviewMessage('{"type":"copySource"}')).toEqual({ type: "copySource" });

    const opened: Array<{ path: string; loc?: { line?: number; column?: number } }> = [];
    const diagEvents: Array<{ ok: boolean; error?: string }> = [];
    let copyCount = 0;

    const deps: PreviewBridgeDeps = {
      basePath: () => "/ws/docs/guide.md",
      openUrl: () => undefined,
      openFile: (path, loc) => opened.push({ path, loc }),
      readImageDataUrl: async () => null,
      inject: () => undefined,
      loadMermaidJs: async () => null,
      rememberScroll: () => undefined,
      currentRenderId: () => 1,
      mermaidConfig: () => ({}),
      onDiagramRendered: (res) => diagEvents.push(res),
      onCopySource: () => {
        copyCount += 1;
      },
    };

    await handlePreviewMessage({ type: "link", href: "./sub.ts#L20C4" }, deps);
    expect(opened).toEqual([{ path: "/ws/docs/sub.ts", loc: { line: 20, column: 4 } }]);

    await handlePreviewMessage({ type: "diagramRendered", ok: true }, deps);
    await handlePreviewMessage({ type: "diagramRendered", ok: false, error: "bad" }, deps);
    expect(diagEvents).toEqual([{ ok: true }, { ok: false, error: "bad" }]);

    await handlePreviewMessage({ type: "copySource" }, deps);
    expect(copyCount).toBe(1);
  });
});

describe("unified vector preview runtime (vendor/markdown/page.mjs)", () => {
  test("TOC threshold is 960px, setTheme skips Mermaid on fontSize-only updates, and renderDiagram normalizes & fixes dark SVG text", async () => {
    await import("../vendor/markdown/dist/markdown-runtime.js");
    const rt = globalThis.AedMarkdown as typeof globalThis.AedMarkdown & {
      preprocessMermaidCode: (code: string) => string;
      resolveLegibleTextColor: (raw: string, isDark: boolean, fallback: string) => string;
      installPreview: (
        win: unknown,
        doc: unknown,
        sanitizeFn?: (html: string) => string,
      ) => void;
    };

    expect(MARKDOWN_RUNTIME_JS).toContain(rt.buildId);
    expect(rt.preprocessMermaidCode('flowchart TB\n  A["line1\n    line2\\nline3"]')).toBe(
      'flowchart TB\n  A["line1<br/>line2<br/>line3"]',
    );
    expect(rt.resolveLegibleTextColor("#333", true, "#ede8de")).toBe("#ede8de");
    expect(rt.resolveLegibleTextColor("rgb(0, 0, 0)", true, "#ede8de")).toBe("#ede8de");
    expect(rt.resolveLegibleTextColor("#333", false, "#141414")).toBe("#333");

    // Minimal DOM harness to exercise page.mjs controller logic directly.
    const posted: Array<Record<string, unknown>> = [];
    let themeTextWrites = 0;
    let themeText = "";
    const themeEl = {
      get textContent() {
        return themeText;
      },
      set textContent(v: string) {
        themeTextWrites += 1;
        themeText = v;
      },
    };

    const makeClassList = () => {
      const set = new Set<string>();
      return {
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
        contains: (c: string) => set.has(c),
        toggle: (c: string, on?: boolean) => {
          if (on === undefined ? !set.has(c) : on) set.add(c);
          else set.delete(c);
        },
      };
    };

    const svgTextNode = {
      attrs: new Map<string, string>([["fill", "#333333"]]),
      style: {} as Record<string, string>,
      getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
      },
      setAttribute(k: string, v: string) {
        this.attrs.set(k, v);
      },
    };
    const svgEl = {
      style: {} as Record<string, string>,
      getAttribute: (k: string) => (k === "viewBox" ? "0 0 400 200" : null),
      querySelectorAll: (sel: string) => (sel === "text" ? [svgTextNode] : []),
    };

    const contentChildren: Array<Record<string, unknown>> = [];
    const contentEl = {
      innerHTML: "",
      textContent: "",
      clientWidth: 800,
      style: {},
      appendChild(child: Record<string, unknown>) {
        contentChildren.push(child);
      },
      querySelectorAll: () => [],
    };
    const tocEl = {
      innerHTML: "",
      classList: makeClassList(),
      appendChild() {},
    };
    tocEl.classList.add("aed-toc-hidden");

    const bodyEl = { classList: makeClassList(), appendChild() {} };
    let mermaidRenders: string[] = [];

    const mockWin: Record<string, unknown> = {
      innerWidth: 1040,
      innerHeight: 800,
      scrollY: 0,
      nsh: {
        postMessage: (raw: string) => posted.push(JSON.parse(raw) as Record<string, unknown>),
      },
      mermaid: {
        initialize() {},
        render: async (_id: string, code: string) => {
          mermaidRenders.push(code);
          return { svg: "<svg viewBox='0 0 400 200'><text fill='#333333'>Node</text></svg>" };
        },
      },
      getComputedStyle: () => ({
        paddingLeft: "24",
        paddingRight: "24",
        fill: "#333333",
        color: "#000000",
      }),
      requestAnimationFrame: (fn: () => void) => fn(),
      scrollTo() {},
      setTimeout,
      addEventListener() {},
    };

    const mockDoc = {
      body: bodyEl,
      getElementById: (id: string) => {
        if (id === "aed-theme") return themeEl;
        if (id === "aed-content") return contentEl;
        if (id === "aed-toc") return tocEl;
        return null;
      },
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        innerHTML: "",
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        classList: makeClassList(),
        appendChild() {},
        addEventListener() {},
        querySelector: (sel: string) => (sel === "svg" ? svgEl : null),
        querySelectorAll: () => [],
      }),
      querySelectorAll: (sel: string) => {
        if (sel === ".aed-mermaid-svg") return contentChildren;
        if (sel.includes("aed-mermaid-svg")) return contentChildren;
        return [];
      },
      addEventListener() {},
    };

    rt.installPreview(mockWin, mockDoc, (html) => html);
    const api = mockWin.__aed as {
      render: (p: Record<string, unknown>) => void;
      setTheme: (p: Record<string, unknown>) => void;
      renderDiagram: (p: Record<string, unknown>) => Promise<void>;
      copySource: () => void;
    };

    // 1) TOC appears at 1040px (>= 960px) and hides at 959px.
    const darkCfg = { theme: "base", themeVariables: { darkMode: true, primaryTextColor: "#ede8de" } };
    api.render({
      renderId: 1,
      path: "/a.md",
      markdown: "# One\n\n## Two\n\ntext",
      themeCss: "body{font-size:13px}",
      scrollY: 0,
      mermaidConfig: darkCfg,
    });
    expect(tocEl.classList.contains("aed-toc-hidden")).toBe(false);
    expect(bodyEl.classList.contains("aed-has-toc")).toBe(true);

    mockWin.innerWidth = 959;
    api.render({
      renderId: 2,
      path: "/a.md",
      markdown: "# One\n\n## Two\n\ntext",
      themeCss: "body{font-size:13px}",
      scrollY: 0,
      mermaidConfig: darkCfg,
    });
    expect(tocEl.classList.contains("aed-toc-hidden")).toBe(true);

    // 2) Guard #aed-theme.textContent: identical CSS does not write textContent again.
    const writesBefore = themeTextWrites;
    api.setTheme({ themeCss: "body{font-size:13px}", mermaidConfig: darkCfg });
    expect(themeTextWrites).toBe(writesBefore);

    // 3) Standalone diagram render: preprocesses code, hides TOC, fixes dark #333333 fill, posts diagramRendered.
    contentChildren.length = 0;
    mermaidRenders = [];
    posted.length = 0;
    mockWin.innerWidth = 1200;
    await api.renderDiagram({
      type: "renderDiagram",
      code: 'flowchart TB\n  A["hello\\nworld"]',
      themeCss: "body{font-size:13px}",
      mermaidConfig: darkCfg,
    });
    expect(bodyEl.classList.contains("aed-diagram-only")).toBe(true);
    expect(tocEl.classList.contains("aed-toc-hidden")).toBe(true);
    expect(mermaidRenders).toEqual(['flowchart TB\n  A["hello<br/>world"]']);
    expect(svgTextNode.getAttribute("fill")).toBe("#ede8de");
    expect(posted).toEqual([{ type: "diagramRendered", ok: true }]);

    // 4) Font-size-only setTheme updates CSS once but does NOT re-render Mermaid when mermaidConfig JSON matches!
    api.setTheme({ themeCss: "body{font-size:15px}", mermaidConfig: { ...darkCfg } });
    expect(themeTextWrites).toBe(writesBefore + 1);
    expect(mermaidRenders.length).toBe(1);

    // Changing mermaidConfig DOES re-render Mermaid.
    const nextCfg = { theme: "base", themeVariables: { darkMode: false, primaryTextColor: "#141414" } };
    api.setTheme({ themeCss: "body{font-size:15px}", mermaidConfig: nextCfg });
    await new Promise((r) => setTimeout(r, 0));
    expect(mermaidRenders.length).toBe(2);

    // 5) copySource posts { type: "copySource" } and syntax errors post ok: false.
    posted.length = 0;
    api.copySource();
    expect(posted).toEqual([{ type: "copySource" }]);

    posted.length = 0;
    mockWin.mermaid = {
      initialize() {},
      render: async () => {
        throw new Error("Invalid flowchart syntax");
      },
    };
    await api.renderDiagram({
      type: "renderDiagram",
      code: "flowchart ???",
      themeCss: "body{font-size:15px}",
      mermaidConfig: nextCfg,
    });
    expect(posted).toEqual([
      { type: "diagramRendered", ok: false, error: "Invalid flowchart syntax" },
    ]);
  });
});
