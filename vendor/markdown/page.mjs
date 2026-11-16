// Page runtime for Aed's unified markdown + standalone diagram preview.
// Runs inside the sandboxed preview WebView; the host drives it via
// window.__aed.* calls through ref.injectJavaScript and reads page messages
// through window.nsh.postMessage.
//
// DESIGN.md「文件预览与 Mermaid 渲染契约」documents this protocol.
import "./entry.mjs";
import createDOMPurify from "dompurify";

const TRANSPARENT_COLORS = new Set(["none", "rgba(0, 0, 0, 0)", "transparent"]);
const DARK_ILLEGIBLE_COLORS = new Set([
  "rgb(0, 0, 0)",
  "rgb(51, 51, 51)",
  "#000",
  "#000000",
  "#333",
  "#333333",
]);

export function preprocessMermaidCode(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\\n/g, "<br/>");
  return trimmed.replace(/"([^"]*)"/g, (_, inner) => {
    const joined = inner.replace(/\r?\n[ \t]*/g, "<br/>");
    return `"${joined}"`;
  });
}

export function resolveLegibleTextColor(raw, isDark, fallback) {
  if (!raw) return fallback;
  const norm = String(raw).trim().toLowerCase();
  if (TRANSPARENT_COLORS.has(norm)) return fallback;
  if (isDark && DARK_ILLEGIBLE_COLORS.has(norm)) return fallback;
  return raw;
}

function makeDefaultSanitizer(win) {
  const DOMPurify = createDOMPurify(win);
  return (html) =>
    DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ["target", "rel", "align", "open"],
    });
}

function postToHost(ctx, obj) {
  try {
    ctx.win.nsh.postMessage(JSON.stringify(obj));
  } catch {
    // Host gone or bridge unavailable; drop the message.
  }
}

function setThemeCss(ctx, css) {
  const next = css || "";
  const styleEl = ctx.doc.getElementById("aed-theme");
  if (styleEl && styleEl.textContent !== next) {
    styleEl.textContent = next;
  }
}

function updateMermaidConfig(state, cfg) {
  if (!cfg) return false;
  const nextJson = JSON.stringify(cfg);
  if (nextJson === state.mermaidConfigJson) return false;
  state.mermaidConfig = cfg;
  state.mermaidConfigJson = nextJson;
  return true;
}

function copyViaTextarea(ctx, text, done) {
  try {
    const ta = ctx.doc.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ctx.doc.body.appendChild(ta);
    ta.select();
    const ok = ctx.doc.execCommand("copy");
    ta.remove();
    done(ok);
  } catch {
    done(false);
  }
}

function copyText(ctx, text, done) {
  const clip = ctx.win.navigator && ctx.win.navigator.clipboard;
  if (clip && clip.writeText) {
    clip.writeText(text).then(
      () => done(true),
      () => copyViaTextarea(ctx, text, done),
    );
    return;
  }
  copyViaTextarea(ctx, text, done);
}

function attachCopyButton(ctx, pre) {
  const btn = ctx.doc.createElement("button");
  btn.type = "button";
  btn.className = "aed-copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    const code = pre.querySelector("code");
    const raw = code ? code.textContent || "" : pre.textContent || "";
    copyText(ctx, raw, (ok) => {
      if (!ok) return;
      btn.textContent = "Copied";
      ctx.win.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1200);
    });
  });
  pre.appendChild(btn);
}

function decorateCodeBlocks(ctx, root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.classList.contains("mermaid")) continue;
    if (pre.querySelector(".aed-copy")) continue;
    attachCopyButton(ctx, pre);
  }
}

function shouldShowToc(ctx) {
  if (ctx.state.mode === "diagram") return false;
  const eligible = ctx.state.headings.filter((h) => h.level >= 1 && h.level <= 3);
  return ctx.win.innerWidth >= 960 && eligible.length >= 2;
}

function hideToc(ctx) {
  const nav = ctx.doc.getElementById("aed-toc");
  if (nav) {
    nav.innerHTML = "";
    nav.classList.add("aed-toc-hidden");
  }
  ctx.state.tocItems = [];
  ctx.doc.body.classList.remove("aed-has-toc");
}

function scrollToId(ctx, id) {
  const el =
    ctx.doc.getElementById(id) ||
    ctx.doc.getElementById(decodeURIComponent(id));
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function createTocLink(ctx, h) {
  const item = ctx.doc.createElement("a");
  item.className = `aed-toc-item aed-toc-level-${h.level}`;
  item.textContent = h.text;
  item.dataset.target = h.id;
  item.href = `#${h.id}`;
  item.addEventListener("click", (e) => {
    e.preventDefault();
    scrollToId(ctx, h.id);
  });
  return item;
}

function buildToc(ctx, headings) {
  ctx.state.headings = headings;
  const nav = ctx.doc.getElementById("aed-toc");
  if (!nav) return;
  if (!shouldShowToc(ctx)) {
    hideToc(ctx);
    return;
  }
  nav.innerHTML = "";
  ctx.state.tocItems = [];
  nav.classList.remove("aed-toc-hidden");
  ctx.doc.body.classList.add("aed-has-toc");
  const label = ctx.doc.createElement("div");
  label.className = "aed-toc-label";
  label.textContent = "Contents";
  nav.appendChild(label);
  const list = ctx.doc.createElement("div");
  list.className = "aed-toc-list";
  for (const h of ctx.state.headings) {
    if (h.level < 1 || h.level > 3) continue;
    const item = createTocLink(ctx, h);
    list.appendChild(item);
    ctx.state.tocItems.push({ id: h.id, el: item });
  }
  nav.appendChild(list);
}

function updateCurrentHeading(ctx) {
  if (ctx.state.tocItems.length === 0) return;
  const threshold = ctx.win.innerHeight * 0.25;
  let current = "";
  for (const it of ctx.state.tocItems) {
    const el = ctx.doc.getElementById(it.id);
    if (el && el.getBoundingClientRect().top <= threshold) current = it.id;
  }
  for (const it of ctx.state.tocItems) {
    it.el.classList.toggle("aed-toc-current", it.id === current);
  }
}

function requestImages(ctx, root, renderId) {
  const srcs = [];
  const seen = new Set();
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("https:") || src.startsWith("data:")) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    srcs.push(src);
  }
  if (srcs.length > 0) postToHost(ctx, { type: "images", renderId, srcs });
}

function columnWidth(ctx) {
  const main = ctx.doc.getElementById("aed-content");
  if (!main) return 700;
  const st = ctx.win.getComputedStyle(main);
  return (
    main.clientWidth -
    parseFloat(st.paddingLeft || "0") -
    parseFloat(st.paddingRight || "0")
  );
}

function fixSvgTextFills(ctx, svgEl, fallback) {
  for (const t of svgEl.querySelectorAll("text")) {
    const cs = ctx.win.getComputedStyle(t);
    const attrFill = t.getAttribute("fill");
    const cur = attrFill && attrFill !== "none" ? attrFill : cs.fill;
    const next = resolveLegibleTextColor(cur, true, fallback);
    if (next && next !== cur) t.setAttribute("fill", next);
  }
}

function fixForeignObjectColors(ctx, svgEl, fallback) {
  const selector =
    "foreignObject .nodeLabel, foreignObject .edgeLabel, foreignObject .cluster-label, foreignObject span, foreignObject div, foreignObject p";
  for (const el of svgEl.querySelectorAll(selector)) {
    const cs = ctx.win.getComputedStyle(el);
    const cur = (el.style && el.style.color) || cs.color;
    const next = resolveLegibleTextColor(cur, true, fallback);
    if (next && next !== cur && el.style) el.style.color = next;
  }
}

function fixMermaidSvgLegibility(ctx, svgEl) {
  if (!svgEl) return;
  const tv = (ctx.state.mermaidConfig && ctx.state.mermaidConfig.themeVariables) || {};
  if (!tv.darkMode) return;
  const fallback = tv.primaryTextColor || "#ede8de";
  fixSvgTextFills(ctx, svgEl, fallback);
  fixForeignObjectColors(ctx, svgEl, fallback);
}

function fitOneSvgHolder(holder, col) {
  const svg = holder.querySelector("svg");
  if (!svg) return;
  const vb = (svg.getAttribute("viewBox") || "").split(/\s+/);
  const natW = parseFloat(vb[2] || "0");
  const natH = parseFloat(vb[3] || "0");
  if (!natW || !natH) return;
  const scale = Math.min(1, Math.max(col / natW, 0.66));
  svg.style.height = "auto";
  if (scale < 1) {
    svg.style.maxWidth = "none";
    svg.style.width = `${Math.round(natW * scale)}px`;
  }
  holder.dataset.scale = String(Math.round(scale * 1000) / 1000);
  holder.style.overflowX = natW * scale > col ? "auto" : "";
}

function fitMermaidSvgs(ctx) {
  const col = columnWidth(ctx);
  for (const holder of ctx.doc.querySelectorAll(".aed-mermaid-svg")) {
    fitOneSvgHolder(holder, col);
  }
}

function initMermaid(ctx) {
  try {
    ctx.win.mermaid.initialize({
      ...ctx.state.mermaidConfig,
      startOnLoad: false,
    });
  } catch {
    // Bad config should not break the page.
  }
}

function mountRenderedMermaidBlock(ctx, el, rawCode, svgMarkup) {
  if (el.tagName !== "PRE") {
    el.innerHTML = svgMarkup;
    return el;
  }
  const holder = ctx.doc.createElement("div");
  holder.className = "aed-mermaid-svg";
  holder.dataset.code = rawCode;
  holder.innerHTML = svgMarkup;
  el.replaceWith(holder);
  return holder;
}

async function renderMermaidBlocks(ctx) {
  if (!ctx.win.mermaid) return;
  initMermaid(ctx);
  let i = 0;
  const targets = ctx.doc.querySelectorAll("pre.mermaid, .aed-mermaid-svg[data-code]");
  for (const el of targets) {
    const rawCode = el.dataset.code ?? el.textContent ?? "";
    el.dataset.code = rawCode;
    const prepared = preprocessMermaidCode(rawCode);
    if (!prepared) continue;
    try {
      const out = await ctx.win.mermaid.render(`aed-mmd-${Date.now()}-${i}`, prepared);
      i += 1;
      const holder = mountRenderedMermaidBlock(ctx, el, rawCode, out.svg);
      fixMermaidSvgLegibility(ctx, holder.querySelector("svg"));
    } catch {
      // Leave the block as source code on a render failure.
    }
  }
  fitMermaidSvgs(ctx);
}

function removeStrayMermaidNode(doc, domId) {
  const stray = doc.getElementById(`d${domId}`) || doc.getElementById(domId);
  if (stray && stray.remove) stray.remove();
}

function mountStandaloneSvg(ctx, root, svgMarkup) {
  const holder = ctx.doc.createElement("div");
  holder.className = "aed-mermaid-svg aed-diagram-standalone";
  holder.dataset.code = ctx.state.diagramCode;
  holder.innerHTML = svgMarkup;
  root.innerHTML = "";
  root.appendChild(holder);
  fixMermaidSvgLegibility(ctx, holder.querySelector("svg"));
  fitMermaidSvgs(ctx);
}

function errorTextOf(err) {
  return err && err.message ? err.message : String(err);
}

async function renderStandaloneDiagram(ctx) {
  if (!ctx.win.mermaid || ctx.state.mode !== "diagram") return;
  const root = ctx.doc.getElementById("aed-content");
  if (!root) return;
  const seq = ++ctx.state.diagramSeq;
  const prepared = preprocessMermaidCode(ctx.state.diagramCode);
  if (!prepared) {
    root.innerHTML = "";
    postToHost(ctx, { type: "diagramRendered", ok: true });
    return;
  }
  initMermaid(ctx);
  const domId = `aed-diag-${Date.now()}-${seq}`;
  try {
    const out = await ctx.win.mermaid.render(domId, prepared);
    if (seq !== ctx.state.diagramSeq || ctx.state.mode !== "diagram") return;
    mountStandaloneSvg(ctx, root, out.svg);
    postToHost(ctx, { type: "diagramRendered", ok: true });
  } catch (err) {
    removeStrayMermaidNode(ctx.doc, domId);
    if (seq !== ctx.state.diagramSeq || ctx.state.mode !== "diagram") return;
    postToHost(ctx, { type: "diagramRendered", ok: false, error: errorTextOf(err) });
  }
}

function requestMermaidBundle(ctx) {
  if (!ctx.state.mermaidRequested) {
    ctx.state.mermaidRequested = true;
    postToHost(ctx, { type: "needMermaid" });
  }
}

function requestMermaidIfNeeded(ctx, root) {
  if (root.querySelectorAll("pre.mermaid").length === 0) return;
  if (ctx.win.mermaid) {
    void renderMermaidBlocks(ctx);
    return;
  }
  requestMermaidBundle(ctx);
}

function renderMarkdownPayload(ctx, p) {
  ctx.state.mode = "markdown";
  ctx.state.renderId = p.renderId;
  ctx.state.path = p.path;
  ctx.doc.body.classList.remove("aed-diagram-only");
  updateMermaidConfig(ctx.state, p.mermaidConfig);
  setThemeCss(ctx, p.themeCss);
  const root = ctx.doc.getElementById("aed-content");
  if (!root) return;
  let out;
  try {
    out = globalThis.AedMarkdown.renderMarkdown(p.markdown || "");
  } catch (err) {
    root.textContent = `Markdown render failed: ${err && err.message ? err.message : err}`;
    return;
  }
  root.innerHTML = ctx.sanitize(out.html);
  decorateCodeBlocks(ctx, root);
  buildToc(ctx, out.headings);
  requestImages(ctx, root, p.renderId);
  requestMermaidIfNeeded(ctx, root);
  const scrollY = p.scrollY || 0;
  ctx.win.requestAnimationFrame(() => {
    ctx.win.requestAnimationFrame(() => ctx.win.scrollTo(0, scrollY));
  });
  updateCurrentHeading(ctx);
}

async function renderDiagramPayload(ctx, p) {
  if (!p) return;
  ctx.state.mode = "diagram";
  if (typeof p.renderId === "number") ctx.state.renderId = p.renderId;
  ctx.state.path = p.path || "";
  ctx.state.headings = [];
  ctx.state.diagramCode = String(p.code ?? "");
  ctx.doc.body.classList.add("aed-diagram-only");
  hideToc(ctx);
  updateMermaidConfig(ctx.state, p.mermaidConfig);
  setThemeCss(ctx, p.themeCss);
  const root = ctx.doc.getElementById("aed-content");
  if (!root) return;
  if (!ctx.win.mermaid) {
    root.innerHTML = "";
    requestMermaidBundle(ctx);
    return;
  }
  await renderStandaloneDiagram(ctx);
}

function applyThemePayload(ctx, p) {
  if (!p) return;
  setThemeCss(ctx, p.themeCss);
  const configChanged = updateMermaidConfig(ctx.state, p.mermaidConfig);
  if (!configChanged || !ctx.win.mermaid) return;
  if (ctx.state.mode === "diagram") void renderStandaloneDiagram(ctx);
  else void renderMermaidBlocks(ctx);
}

function applySingleImage(img, dataUrl) {
  if (dataUrl) {
    img.setAttribute("src", dataUrl);
    img.classList.remove("aed-img-missing");
  } else {
    img.removeAttribute("src");
    img.classList.add("aed-img-missing");
  }
}

function applyImagesPayload(ctx, p) {
  if (!p || p.renderId !== ctx.state.renderId) return;
  const images = p.images || {};
  for (const src of Object.keys(images)) {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(src) : src;
    for (const img of ctx.doc.querySelectorAll(`img[src="${escaped}"]`)) {
      applySingleImage(img, images[src]);
    }
  }
}

function markMermaidUnavailable(ctx) {
  if (ctx.state.mode === "diagram") {
    const root = ctx.doc.getElementById("aed-content");
    if (root) {
      const cap = ctx.doc.createElement("p");
      cap.className = "aed-mermaid-unavailable";
      cap.textContent = "Diagram renderer unavailable offline";
      root.innerHTML = "";
      root.appendChild(cap);
    }
    postToHost(ctx, {
      type: "diagramRendered",
      ok: false,
      error: "Diagram renderer unavailable offline",
    });
    return;
  }
  for (const pre of ctx.doc.querySelectorAll("pre.mermaid")) {
    const cap = ctx.doc.createElement("p");
    cap.className = "aed-mermaid-unavailable";
    cap.textContent = "Diagram renderer unavailable offline";
    pre.after(cap);
  }
}

function handleLinkClick(ctx, e) {
  const t = e.target;
  const a = t && t.closest ? t.closest("a") : null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  e.preventDefault();
  if (href.startsWith("#")) scrollToId(ctx, href.slice(1));
  else if (href) postToHost(ctx, { type: "link", href });
}

function bindScrollSync(ctx) {
  let scrollTimer = 0;
  ctx.win.addEventListener("scroll", () => {
    if (ctx.state.mode === "diagram") return;
    updateCurrentHeading(ctx);
    if (scrollTimer) return;
    scrollTimer = ctx.win.setTimeout(() => {
      scrollTimer = 0;
      postToHost(ctx, {
        type: "scroll",
        path: ctx.state.path,
        y: Math.round(ctx.win.scrollY),
      });
    }, 200);
  });
}

function bindPageEvents(ctx) {
  ctx.doc.addEventListener("click", (e) => handleLinkClick(ctx, e));
  bindScrollSync(ctx);
  ctx.win.addEventListener("resize", () => {
    if (ctx.state.mode !== "diagram") {
      buildToc(ctx, ctx.state.headings);
      updateCurrentHeading(ctx);
    }
    fitMermaidSvgs(ctx);
  });
}

export function installPreview(win, doc, customSanitize) {
  if (!win || !doc || win.__aed) return;
  const ctx = {
    win,
    doc,
    sanitize: customSanitize || makeDefaultSanitizer(win),
    state: {
      mode: "markdown",
      renderId: 0,
      diagramSeq: 0,
      diagramCode: "",
      path: "",
      mermaidConfig: {},
      mermaidConfigJson: "",
      mermaidRequested: false,
      headings: [],
      tocItems: [],
    },
  };

  bindPageEvents(ctx);

  const api = {
    render: (p) => renderMarkdownPayload(ctx, p),
    renderDiagram: (p) => renderDiagramPayload(ctx, p),
    setTheme: (p) => applyThemePayload(ctx, p),
    setImages: (p) => applyImagesPayload(ctx, p),
    mermaidUnavailable: () => markMermaidUnavailable(ctx),
    mermaidReady: () => {
      if (ctx.state.mode === "diagram") void renderStandaloneDiagram(ctx);
      else void renderMermaidBlocks(ctx);
    },
    copySource: () => postToHost(ctx, { type: "copySource" }),
    dispatch: (msg) => {
      if (!msg || typeof msg !== "object") return;
      const fn = api[msg.type];
      if (typeof fn === "function") fn(msg);
    },
  };
  win.__aed = api;
}

if (globalThis.AedMarkdown) {
  globalThis.AedMarkdown.preprocessMermaidCode = preprocessMermaidCode;
  globalThis.AedMarkdown.resolveLegibleTextColor = resolveLegibleTextColor;
  globalThis.AedMarkdown.installPreview = installPreview;
}

if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  !window.__aed
) {
  installPreview(window, document);
}
