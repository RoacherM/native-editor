import path from "path";
import { classifyFile } from "./classify";
import { normalizeExternalFilePath } from "./workspace";
import type { EditorTheme } from "./themes";
import {
  GITHUB_MARKDOWN_CSS,
  KATEX_CSS,
} from "./markdownVendor.generated";

// DESIGN.md「文件预览与 Mermaid 渲染契约」documents this module's contract:
// the markdown WebView preview runs entirely on the page side (JSC); the host
// only ships payloads, answers page requests and owns files/URLs.

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

/** Whether `url` should leave markdown inline navigation entirely alone. */
export function isExternalOrHashUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("#")
  );
}

/** Resolve a relative markdown link to an absolute path, or null. */
export function resolveRelativeLink(
  relUrl: string,
  baseFilePath: string,
): string | null {
  if (isExternalOrHashUrl(relUrl)) return null;
  const withoutAnchor = relUrl.split("#")[0] || "";
  const cleaned = normalizeExternalFilePath(withoutAnchor);
  if (!cleaned) return null;
  if (cleaned.startsWith("/")) return path.normalize(cleaned);
  return path.resolve(path.dirname(baseFilePath), cleaned);
}

export type PreviewLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string }
  | { kind: "none" };

const FORBIDDEN_SCHEMES = /^(javascript|data|vbscript|about|blob):/i;
const EXTERNAL_SCHEMES = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ALLOWED_EXTERNAL = /^https?:|^mailto:/i;

function stripAnchorAndQuery(p: string): string {
  return p.split("#")[0].split("?")[0];
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Route a clicked markdown link: http(s)/mailto/tel/ftp/other registered
 * schemes leave the app via `openUrl`; `javascript:`/`data:`/`vbscript:` and
 * in-page `#` anchors are ignored; everything else is a file path resolved
 * against the markdown file's directory.
 */
export function classifyPreviewLink(
  href: string,
  baseFilePath: string,
): PreviewLinkTarget {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return { kind: "none" };
  if (FORBIDDEN_SCHEMES.test(trimmed)) return { kind: "none" };
  let candidate = trimmed;
  if (candidate.startsWith("file://")) {
    candidate = candidate.slice("file://".length);
  } else if (EXTERNAL_SCHEMES.test(candidate)) {
    return ALLOWED_EXTERNAL.test(trimmed)
      ? { kind: "external", url: trimmed }
      : { kind: "none" };
  }
  const withoutMeta = decodePath(stripAnchorAndQuery(candidate));
  const cleaned = normalizeExternalFilePath(withoutMeta);
  if (!cleaned) return { kind: "none" };
  const resolved = cleaned.startsWith("/")
    ? path.normalize(cleaned)
    : path.resolve(path.dirname(baseFilePath), cleaned);
  return { kind: "file", path: resolved };
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
]);

/**
 * Resolve a markdown `<img>` src to an absolute file path. Only local paths
 * with an image extension resolve; `https:`/`data:`/everything else -> null.
 */
export function resolvePreviewImagePath(
  src: string,
  baseFilePath: string,
): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (FORBIDDEN_SCHEMES.test(trimmed)) return null;
  let candidate = trimmed;
  if (candidate.startsWith("file://")) {
    candidate = candidate.slice("file://".length);
  } else if (EXTERNAL_SCHEMES.test(candidate)) {
    return null;
  }
  const decoded = decodePath(stripAnchorAndQuery(candidate));
  const ext = path.extname(decoded).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const cleaned = normalizeExternalFilePath(decoded);
  if (!cleaned) return null;
  return cleaned.startsWith("/")
    ? path.normalize(cleaned)
    : path.resolve(path.dirname(baseFilePath), cleaned);
}

/** MIME type for an image path, reusing classify.ts's extension table. */
export function imageMimeForPath(p: string): string | null {
  const c = classifyFile(p);
  return c.kind === "image" ? c.mimeType : null;
}

export type PreviewMessage =
  | { type: "link"; href: string }
  | { type: "images"; renderId: number; srcs: string[] }
  | { type: "scroll"; path: string; y: number }
  | { type: "needMermaid" };

const MAX_IMAGE_SRCS = 200;

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
  switch (m.type) {
    case "link":
      return typeof m.href === "string" ? { type: "link", href: m.href } : null;
    case "images":
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
    case "scroll":
      return typeof m.path === "string" && typeof m.y === "number"
        ? { type: "scroll", path: m.path, y: m.y }
        : null;
    case "needMermaid":
      return { type: "needMermaid" };
    default:
      return null;
  }
}

export interface PreviewBridgeDeps {
  /** Absolute path of the markdown file being shown. */
  basePath(): string;
  openUrl(url: string): void;
  openFile(path: string): void;
  /** Absolute image path -> `data:` URL (null on any failure). */
  readImageDataUrl(path: string): Promise<string | null>;
  inject(js: string): void;
  loadMermaidJs(): Promise<string | null>;
  rememberScroll(path: string, y: number): void;
  currentRenderId(): number;
  mermaidConfig(): unknown;
}

/** Route a validated page message to its host-side effect. */
export async function handlePreviewMessage(
  msg: PreviewMessage,
  deps: PreviewBridgeDeps,
): Promise<void> {
  switch (msg.type) {
    case "link": {
      const target = classifyPreviewLink(msg.href, deps.basePath());
      if (target.kind === "external") deps.openUrl(target.url);
      else if (target.kind === "file") deps.openFile(target.path);
      return;
    }
    case "images": {
      if (msg.renderId !== deps.currentRenderId()) return;
      const base = deps.basePath();
      const entries = await Promise.all(
        msg.srcs.map(async (src) => {
          const p = resolvePreviewImagePath(src, base);
          const dataUrl = p ? await deps.readImageDataUrl(p) : null;
          return [src, dataUrl] as const;
        }),
      );
      const images = Object.fromEntries(entries);
      deps.inject(
        `window.__aed.setImages(${JSON.stringify({
          renderId: msg.renderId,
          images,
        })});`,
      );
      return;
    }
    case "scroll":
      deps.rememberScroll(msg.path, msg.y);
      return;
    case "needMermaid": {
      const bundle = await deps.loadMermaidJs();
      if (bundle) {
        deps.inject(bundle);
        deps.inject("window.__aed.mermaidReady();");
      } else {
        deps.inject("window.__aed.mermaidUnavailable();");
      }
      return;
    }
  }
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
/* When the 220px TOC shows (right: 24px + 32px gap), shrink the centering
   space so the column never runs under it. */
body.aed-has-toc { padding-right: 276px; }
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
  right: 24px;
  width: 220px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  padding: 0;
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
