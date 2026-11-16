import path from "path";
import { imageMimeForPath } from "./classify";
import { parseTarget } from "./target";
import type { EditorTheme } from "./themes";
import {
  GITHUB_MARKDOWN_CSS,
  KATEX_CSS,
} from "./markdownVendor.generated";

export { imageMimeForPath };

// DESIGN.md「文件预览与 Mermaid 渲染契约」documents this module's contract:
// the markdown & diagram WebView preview runs entirely on the page side (JSC);
// the host only ships payloads, answers page requests and owns files/URLs.

/** The Content-Security-Policy the preview shell page runs under. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data: https:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Static shell page for `WebView.html`: CSP + style blocks + containers. */
export function buildPreviewShellHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<style>${GITHUB_MARKDOWN_CSS}</style>
<style>${KATEX_CSS}</style>
<style id="aed-theme"></style>
</head>
<body>
<main id="aed-content" class="markdown-body"></main>
<nav id="aed-toc" class="aed-toc-hidden"></nav>
</body>
</html>`;
}

export type PreviewLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "none" };

/**
 * Route a clicked markdown link through `parseTarget`: `http(s):`/`mailto:`
 * leave the app via `openUrl`; dangerous/unknown schemes, remote `file://`
 * hosts and in-page `#` anchors are ignored; local paths resolve against the
 * markdown file's directory and preserve optional `line`/`column` targets.
 */
export function classifyPreviewLink(
  href: string,
  baseFilePath: string,
): PreviewLinkTarget {
  const parsed = parseTarget(href, { baseDir: path.dirname(baseFilePath) });
  if (parsed.kind === "external") return parsed;
  if (parsed.kind !== "candidates") return { kind: "none" };
  const best = parsed.items.at(-1);
  if (!best) return { kind: "none" };
  return {
    kind: "file",
    path: best.path,
    ...(best.line > 0 ? { line: best.line } : {}),
    ...(best.line > 0 && best.column > 0 ? { column: best.column } : {}),
  };
}

/**
 * Resolve a markdown `<img>` src to an absolute local image path using
 * `parseTarget` + `imageMimeForPath`; external, `data:` or non-image paths
 * return `null`.
 */
export function resolvePreviewImagePath(
  src: string,
  baseFilePath: string,
): string | null {
  const parsed = parseTarget(src, { baseDir: path.dirname(baseFilePath) });
  if (parsed.kind !== "candidates") return null;
  const resolved = parsed.items.at(-1)?.path;
  if (!resolved || !imageMimeForPath(resolved)) return null;
  return resolved;
}

export type PreviewMessage =
  | { type: "link"; href: string }
  | { type: "images"; renderId: number; srcs: string[] }
  | { type: "scroll"; path: string; y: number }
  | { type: "needMermaid" }
  | { type: "diagramRendered"; ok: boolean; error?: string }
  | { type: "copySource" };

const MAX_IMAGE_SRCS = 200;

function parseImagesPayload(m: Record<string, unknown>): PreviewMessage | null {
  if (
    typeof m.renderId !== "number" ||
    !Array.isArray(m.srcs) ||
    !m.srcs.every((s) => typeof s === "string")
  ) {
    return null;
  }
  return {
    type: "images",
    renderId: m.renderId,
    srcs: (m.srcs as string[]).slice(0, MAX_IMAGE_SRCS),
  };
}

function parseDiagramRenderedPayload(m: Record<string, unknown>): PreviewMessage | null {
  if (typeof m.ok !== "boolean") return null;
  if (m.error !== undefined && typeof m.error !== "string") return null;
  return {
    type: "diagramRendered",
    ok: m.ok,
    ...(typeof m.error === "string" ? { error: m.error } : {}),
  };
}

const MESSAGE_PARSERS: Record<
  string,
  (m: Record<string, unknown>) => PreviewMessage | null
> = {
  link: (m) => (typeof m.href === "string" ? { type: "link", href: m.href } : null),
  images: parseImagesPayload,
  scroll: (m) =>
    typeof m.path === "string" && typeof m.y === "number"
      ? { type: "scroll", path: m.path, y: m.y }
      : null,
  needMermaid: () => ({ type: "needMermaid" }),
  diagramRendered: parseDiagramRenderedPayload,
  copySource: () => ({ type: "copySource" }),
};

/** Strictly validate a `window.nsh.postMessage` payload from the page. */
export function parsePreviewMessage(raw: string): PreviewMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const parser = typeof m.type === "string" ? MESSAGE_PARSERS[m.type] : undefined;
  return parser ? parser(m) : null;
}

export interface PreviewBridgeDeps {
  /** Absolute path of the markdown file being shown. */
  basePath(): string;
  openUrl(url: string): void;
  openFile(path: string, loc?: { line?: number; column?: number }): void;
  /** Absolute image path -> `data:` URL (null on any failure). */
  readImageDataUrl(path: string): Promise<string | null>;
  inject(js: string): void;
  loadMermaidJs(): Promise<string | null>;
  rememberScroll(path: string, y: number): void;
  currentRenderId(): number;
  mermaidConfig(): unknown;
  onDiagramRendered?(result: { ok: boolean; error?: string }): void;
  onCopySource?(): void;
}

function routeLinkMessage(href: string, deps: PreviewBridgeDeps): void {
  const target = classifyPreviewLink(href, deps.basePath());
  if (target.kind === "external") {
    deps.openUrl(target.url);
    return;
  }
  if (target.kind === "file") {
    const loc =
      target.line !== undefined
        ? {
            line: target.line,
            ...(target.column !== undefined ? { column: target.column } : {}),
          }
        : undefined;
    if (loc) deps.openFile(target.path, loc);
    else deps.openFile(target.path);
  }
}

async function routeImagesMessage(
  renderId: number,
  srcs: string[],
  deps: PreviewBridgeDeps,
): Promise<void> {
  if (renderId !== deps.currentRenderId()) return;
  const base = deps.basePath();
  const entries = await Promise.all(
    srcs.map(async (src) => {
      const p = resolvePreviewImagePath(src, base);
      const dataUrl = p ? await deps.readImageDataUrl(p) : null;
      return [src, dataUrl] as const;
    }),
  );
  const images = Object.fromEntries(entries);
  deps.inject(
    `window.__aed.setImages(${JSON.stringify({
      renderId,
      images,
    })});`,
  );
}

async function routeNeedMermaidMessage(deps: PreviewBridgeDeps): Promise<void> {
  const bundle = await deps.loadMermaidJs();
  if (bundle) {
    deps.inject(bundle);
    deps.inject("window.__aed.mermaidReady();");
  } else {
    deps.inject("window.__aed.mermaidUnavailable();");
  }
}

function routeDiagramRendered(
  msg: Extract<PreviewMessage, { type: "diagramRendered" }>,
  deps: PreviewBridgeDeps,
): void {
  const payload =
    msg.error !== undefined ? { ok: msg.ok, error: msg.error } : { ok: msg.ok };
  deps.onDiagramRendered?.(payload);
}

const MESSAGE_HANDLERS: {
  [K in PreviewMessage["type"]]: (
    msg: Extract<PreviewMessage, { type: K }>,
    deps: PreviewBridgeDeps,
  ) => Promise<void> | void;
} = {
  link: (msg, deps) => routeLinkMessage(msg.href, deps),
  images: (msg, deps) => routeImagesMessage(msg.renderId, msg.srcs, deps),
  scroll: (msg, deps) => deps.rememberScroll(msg.path, msg.y),
  needMermaid: (_msg, deps) => routeNeedMermaidMessage(deps),
  diagramRendered: routeDiagramRendered,
  copySource: (_msg, deps) => deps.onCopySource?.(),
};

/** Route a validated page message to its host-side effect. */
export async function handlePreviewMessage(
  msg: PreviewMessage,
  deps: PreviewBridgeDeps,
): Promise<void> {
  const handler = MESSAGE_HANDLERS[msg.type] as (
    m: PreviewMessage,
    d: PreviewBridgeDeps,
  ) => Promise<void> | void;
  await handler(msg, deps);
}

export interface PreviewFontStyle {
  fontFamily?: string;
  fontSize: number;
}

/**
 * The `#aed-theme` style block: github-markdown-css variables pinned to the
 * editor theme (its light/dark media queries never win), the reading layout
 * and the Industrial typography rules. All colors come from `theme` /
 * `font` — nothing is hard-coded per theme.
 */
export function buildPreviewThemeCss(
  theme: EditorTheme,
  font: PreviewFontStyle,
): string {
  const ui = theme.ui;
  const sy = theme.syntax;
  const mono = font.fontFamily
    ? `"${font.fontFamily}", ui-monospace, "SF Mono", Menlo, monospace`
    : `ui-monospace, "SF Mono", Menlo, monospace`;

  return `
:root { color-scheme: ${theme.appearance}; }
html, body { margin: 0; padding: 0; background: ${ui.background}; }
body {
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 15px;
  line-height: 1.7;
  color: ${ui.foreground};
}
.markdown-body {
  --fgColor-default: ${ui.foreground};
  --fgColor-muted: ${ui.mutedForeground};
  --fgColor-accent: ${ui.foreground};
  --fgColor-attention: ${sy.number};
  --fgColor-danger: ${ui.accent};
  --fgColor-success: ${sy.string};
  --fgColor-done: ${sy.type};
  --fgColor-neutral: ${ui.mutedForeground};
  --bgColor-default: ${ui.background};
  --bgColor-muted: ${ui.sidebar};
  --bgColor-neutral-muted: ${ui.card};
  --bgColor-attention-subtle: ${ui.card};
  --bgColor-accent-subtle: ${ui.card};
  --bgColor-danger-subtle: ${ui.card};
  --bgColor-success-subtle: ${ui.card};
  --borderColor-default: ${ui.border};
  --borderColor-muted: ${ui.border};
  --borderColor-neutral-muted: ${ui.border};
  --borderColor-accent-emphasis: ${sy.property};
  --borderColor-attention-emphasis: ${sy.number};
  --borderColor-danger-emphasis: ${ui.accent};
  --borderColor-success-emphasis: ${sy.string};
  --borderColor-done-emphasis: ${sy.type};
  --controlTrack-bg: ${ui.card};
  background: ${ui.background};
  color: ${ui.foreground};
  font-size: 15px;
  line-height: 1.7;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  box-sizing: border-box;
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 48px 96px;
}
/* When the TOC shows (196px + 16px trailing pad = 212px at right: 0 + 24px gap),
   shrink the centering space so the column never runs under it. */
body.aed-has-toc { padding-right: 236px; }
@media (max-width: 1120px) {
  .markdown-body { padding: 32px 32px 80px; }
  body.aed-has-toc { padding-right: 220px; }
  body.aed-has-toc .markdown-body { padding: 32px 24px 80px; }
}
body.aed-diagram-only { display: flex; min-height: 100vh; align-items: center; justify-content: center; }
body.aed-diagram-only .markdown-body { max-width: none; width: 100%; margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; }
body.aed-diagram-only .aed-mermaid-svg { margin: 0; width: 100%; }
::selection { background: ${ui.selection}; }

/* — Type rhythm — */
.markdown-body p { margin: 0 0 16px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  font-weight: 600;
  color: ${ui.foreground};
}
.markdown-body h1 { font-size: 28px; line-height: 1.3; margin: 0 0 24px; padding-bottom: 12px; border-bottom: 1px solid ${ui.border}; }
.markdown-body h2 { font-size: 22px; line-height: 1.35; margin: 40px 0 16px; padding-bottom: 8px; border-bottom: 1px solid ${ui.border}; }
.markdown-body h3 { font-size: 18px; margin: 32px 0 12px; }
.markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 15px; margin: 24px 0 8px; }
.markdown-body h6 { color: ${ui.mutedForeground}; }
.markdown-body h1:first-child, .markdown-body h2:first-child, .markdown-body h3:first-child { margin-top: 0; }
.markdown-body strong { font-weight: 600; }
.markdown-body a { color: ${ui.foreground}; text-decoration: underline; text-decoration-color: ${ui.border}; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.markdown-body a:hover { text-decoration-color: ${ui.accent}; }
.markdown-body hr { height: 1px; background: ${ui.border}; border: none; margin: 32px 0; }
.markdown-body img { max-width: 100%; border-radius: 4px; }
.markdown-body img.aed-img-missing { display: inline-block; padding: 2px 8px; border: 1px dashed ${ui.border}; border-radius: 4px; }

/* — Code — */
.markdown-body code {
  font-family: ${mono};
  font-size: 0.86em;
  background: ${ui.card};
  border: none;
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
.markdown-body pre {
  background: ${ui.sidebar};
  border: none;
  border-radius: 8px;
  padding: 16px 20px;
  overflow-x: auto;
  position: relative;
}
.markdown-body pre code {
  background: transparent;
  padding: 0;
  font-family: ${mono};
  font-size: ${font.fontSize}px;
  line-height: 1.6;
}
.markdown-body pre .aed-copy {
  position: absolute;
  top: 8px;
  right: 10px;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 12px;
  color: ${ui.mutedForeground};
  background: transparent;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  opacity: 0;
}
.markdown-body pre:hover .aed-copy { opacity: 1; }
.markdown-body pre .aed-copy:hover { color: ${ui.foreground}; }
/* highlight.js classes -> theme.syntax */
.hljs-keyword, .hljs-selector-tag, .hljs-doctag { color: ${sy.keyword}; }
.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-meta .hljs-string { color: ${sy.string}; }
.hljs-number, .hljs-literal { color: ${sy.number}; }
.hljs-comment, .hljs-quote { color: ${sy.comment}; font-style: italic; }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable, .hljs-name { color: ${sy.property}; }
.hljs-type, .hljs-class, .hljs-title.class_, .hljs-title_ { color: ${sy.type}; }
.hljs-title.function_, .hljs-function .hljs-title, .hljs-section { color: ${sy.function}; }
.hljs-built_in, .hljs-constant, .hljs-builtin-name { color: ${sy.constant}; }
.hljs-operator, .hljs-punctuation { color: ${sy.operator}; }
.hljs-tag, .hljs-selector-class, .hljs-selector-id, .hljs-selector-attr, .hljs-selector-pseudo { color: ${sy.tag}; }
.hljs-addition { color: ${sy.string}; }
.hljs-deletion { color: ${sy.keyword}; }
.hljs-meta, .hljs-subst { color: ${sy.property}; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.hljs-link, .hljs-bullet, .hljs-code { color: ${sy.property}; }

/* — Lists — */
.markdown-body ul, .markdown-body ol { padding-left: 1.6em; margin: 0 0 16px; }
.markdown-body li { margin: 4px 0; }
.markdown-body li ul, .markdown-body li ol { margin: 4px 0; }
.markdown-body li::marker { color: ${ui.mutedForeground}; }
.markdown-body li.task-list-item { list-style: none; margin-left: -1.6em; }
.markdown-body .task-list-item-checkbox { margin: 0 8px 0 0; vertical-align: -1px; accent-color: ${ui.mutedForeground}; }

/* — Quotes & alerts — */
.markdown-body blockquote {
  margin: 0 0 16px;
  padding: 0 0 0 16px;
  border-left: 2px solid ${ui.border};
  color: ${ui.mutedForeground};
}
.markdown-body .markdown-alert { border-left: 2px solid ${ui.border}; padding-left: 16px; margin: 0 0 16px; color: ${ui.foreground}; }
.markdown-body .markdown-alert-title { font-size: 13px; font-weight: 600; text-transform: capitalize; margin: 0 0 4px; }
.markdown-body .markdown-alert.markdown-alert-note { border-left-color: ${sy.property}; }
.markdown-body .markdown-alert.markdown-alert-note .markdown-alert-title { color: ${sy.property}; }
.markdown-body .markdown-alert.markdown-alert-tip { border-left-color: ${sy.string}; }
.markdown-body .markdown-alert.markdown-alert-tip .markdown-alert-title { color: ${sy.string}; }
.markdown-body .markdown-alert.markdown-alert-important { border-left-color: ${sy.type}; }
.markdown-body .markdown-alert.markdown-alert-important .markdown-alert-title { color: ${sy.type}; }
.markdown-body .markdown-alert.markdown-alert-warning { border-left-color: ${sy.number}; }
.markdown-body .markdown-alert.markdown-alert-warning .markdown-alert-title { color: ${sy.number}; }
.markdown-body .markdown-alert.markdown-alert-caution { border-left-color: ${ui.accent}; }
.markdown-body .markdown-alert.markdown-alert-caution .markdown-alert-title { color: ${ui.accent}; }

/* — Tables — */
.markdown-body table { border-collapse: collapse; margin: 0 0 16px; display: block; overflow-x: auto; font-variant-numeric: tabular-nums; }
.markdown-body table thead tr { background: ${ui.sidebar}; }
.markdown-body table th, .markdown-body table td { border: 1px solid ${ui.border}; padding: 6px 12px; }

/* — Footnotes, details, mermaid — */
.markdown-body .footnotes { font-size: 0.9em; color: ${ui.mutedForeground}; }
.markdown-body hr.footnotes-sep { display: none; }
.markdown-body details { margin: 0 0 16px; }
.aed-mermaid-svg { text-align: center; margin: 0 0 16px; }
.aed-mermaid-svg svg { max-width: 100%; height: auto; background: transparent; }
.aed-mermaid-unavailable { font-size: 12px; color: ${ui.mutedForeground}; margin: -8px 0 16px; }
.markdown-body pre.mermaid { color: ${sy.comment}; }

/* — Table of contents — */
#aed-toc {
  position: fixed;
  top: 40px;
  right: 0;
  width: 196px;
  padding: 0;
  padding-right: 16px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
#aed-toc.aed-toc-hidden { display: none; }
.aed-toc-label { font-size: 12px; font-weight: 500; color: ${ui.mutedForeground}; margin-bottom: 8px; }
.aed-toc-item {
  display: block;
  font-size: 13px;
  line-height: 1.5;
  color: ${ui.mutedForeground};
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 0 2px 8px;
  margin: 4px 0;
  border-left: 2px solid transparent;
}
.aed-toc-level-3 { padding-left: 20px; }
.aed-toc-item:hover { color: ${ui.foreground}; text-decoration: none; }
.aed-toc-item.aed-toc-current { color: ${ui.foreground}; border-left-color: ${ui.accent}; }
`;
}
