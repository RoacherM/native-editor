// Markdown runtime: builds the markdown-it pipeline and exposes
// globalThis.AedMarkdown.renderMarkdown. Imported by the page bundle and
// evaluated on the nsh host in tests — must not touch `document` here.
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import anchor from "markdown-it-anchor";
import { alert } from "@mdit/plugin-alert";
import hljs from "highlight.js/lib/common";
import katexImport from "@vscode/markdown-it-katex";

// CJS/ESM interop differs between bun's iife and esm output: normalize
// `{ default: plugin }` namespace shapes to the plugin function itself.
const asPlugin = (m) => (typeof m === "function" ? m : m.default ?? m);
const katexPlugin = asPlugin(katexImport);

// GitHub-style slug: lowercase, spaces -> "-", letters/numbers/-/_
// (CJK and other unicode letters) kept, other punctuation dropped.
function slugifyGithub(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
    .replace(/\s+/g, "-");
}

let slugCounts = new Map();
function uniqueSlug(s) {
  const base = slugifyGithub(s);
  const n = slugCounts.get(base) ?? 0;
  slugCounts.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true })
          .value;
      } catch {
        // Fall through to escaped output.
      }
    }
    return md.utils.escapeHtml(str);
  },
});

md.use(asPlugin(footnote));
md.use(asPlugin(taskLists), { enabled: false, label: true });
md.use(asPlugin(anchor), { slugify: uniqueSlug });
md.use(alert);
md.use(katexPlugin);

// ```mermaid fences render as escaped source in <pre class="mermaid"> for the
// page runtime to lay out with the shared Mermaid bundle.
const defaultFence =
  md.renderer.rules.fence ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : "";
  const lang = info.split(/(\s+)/g)[0];
  if (lang === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

export function renderMarkdown(src) {
  slugCounts = new Map();
  const env = {};
  const tokens = md.parse(src, env);
  const html = md.renderer.render(tokens, md.options, env);
  const headings = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open") {
      const inline = tokens[i + 1];
      headings.push({
        level: Number(t.tag.slice(1)),
        text: inline ? inline.content : "",
        id: t.attrGet("id") ?? "",
      });
    }
  }
  return { html, headings };
}

globalThis.AedMarkdown = { renderMarkdown };
