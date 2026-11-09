// Page runtime for Aed's markdown preview. Runs only when `document` exists
// (injected into the preview WebView); the host drives it via
// window.__aed.* calls through ref.injectJavaScript and reads page messages
// through window.nsh.postMessage.
//
// DESIGN.md「文件预览与 Mermaid 渲染契约」documents this protocol.
import "./entry.mjs";
import createDOMPurify from "dompurify";

// Install guard: the runtime is injected once per page load; a duplicate
// inject must not attach listeners again or reset state.
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  !window.__aed
) {
  const DOMPurify = createDOMPurify(window);

  const state = {
    renderId: 0,
    path: "",
    mermaidConfig: {},
    mermaidRequested: false,
    headings: [],
    tocItems: [],
  };

  function post(obj) {
    try {
      window.nsh.postMessage(JSON.stringify(obj));
    } catch {
      // Host gone or bridge unavailable; drop the message.
    }
  }

  function contentEl() {
    return document.getElementById("aed-content");
  }

  function tocEl() {
    return document.getElementById("aed-toc");
  }

  function setThemeCss(css) {
    const el = document.getElementById("aed-theme");
    if (el) el.textContent = css || "";
  }

  function sanitize(html) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ["target", "rel", "align", "open"],
    });
  }

  function copyText(text, done) {
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        done(ok);
      } catch {
        done(false);
      }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => done(true),
          () => fallback(),
        );
        return;
      }
    } catch {
      // fall through
    }
    fallback();
  }

  function decorateCodeBlocks(root) {
    for (const pre of root.querySelectorAll("pre")) {
      if (pre.classList.contains("mermaid")) continue;
      if (pre.querySelector(".aed-copy")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "aed-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        copyText(code ? code.textContent || "" : pre.textContent || "", (ok) => {
          if (ok) {
            btn.textContent = "Copied";
            setTimeout(() => {
              btn.textContent = "Copy";
            }, 1200);
          }
        });
      });
      pre.appendChild(btn);
    }
  }

  function shouldShowToc() {
    const eligible = state.headings.filter((h) => h.level >= 1 && h.level <= 3);
    return window.innerWidth >= 1120 && eligible.length >= 2;
  }

  function buildToc(headings) {
    state.headings = headings;
    const nav = tocEl();
    if (!nav) return;
    nav.innerHTML = "";
    state.tocItems = [];
    if (!shouldShowToc()) {
      nav.classList.add("aed-toc-hidden");
      document.body.classList.remove("aed-has-toc");
      return;
    }
    nav.classList.remove("aed-toc-hidden");
    document.body.classList.add("aed-has-toc");
    const label = document.createElement("div");
    label.className = "aed-toc-label";
    label.textContent = "Contents";
    nav.appendChild(label);
    const list = document.createElement("div");
    list.className = "aed-toc-list";
    for (const h of state.headings) {
      if (h.level < 1 || h.level > 3) continue;
      const item = document.createElement("a");
      item.className = `aed-toc-item aed-toc-level-${h.level}`;
      item.textContent = h.text;
      item.dataset.target = h.id;
      item.href = `#${h.id}`;
      item.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToId(h.id);
      });
      list.appendChild(item);
      state.tocItems.push({ id: h.id, el: item });
    }
    nav.appendChild(list);
  }

  function scrollToId(id) {
    const el =
      document.getElementById(id) ||
      document.getElementById(decodeURIComponent(id));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateCurrentHeading() {
    if (state.tocItems.length === 0) return;
    const threshold = window.innerHeight * 0.25;
    let current = "";
    for (const it of state.tocItems) {
      const el = document.getElementById(it.id);
      if (el && el.getBoundingClientRect().top <= threshold) current = it.id;
    }
    for (const it of state.tocItems) {
      it.el.classList.toggle("aed-toc-current", it.id === current);
    }
  }

  function requestImages(root, renderId) {
    const srcs = [];
    const seen = new Set();
    for (const img of root.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("https:") || src.startsWith("data:")) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      srcs.push(src);
    }
    if (srcs.length > 0) post({ type: "images", renderId, srcs });
  }

  function mermaidTargets() {
    return document.querySelectorAll("pre.mermaid, .aed-mermaid-svg[data-code]");
  }

  function columnWidth() {
    const main = contentEl();
    if (!main) return 700;
    const st = getComputedStyle(main);
    return (
      main.clientWidth -
      parseFloat(st.paddingLeft || "0") -
      parseFloat(st.paddingRight || "0")
    );
  }

  // Fit every rendered diagram: height:auto kills the letterboxing; diagrams
  // wider than the column shrink to at least 0.66x, and if that still
  // overflows the container scrolls horizontally instead of shrinking more.
  function fitMermaidSvgs() {
    const col = columnWidth();
    for (const holder of document.querySelectorAll(".aed-mermaid-svg")) {
      const svg = holder.querySelector("svg");
      if (!svg) continue;
      const vb = (svg.getAttribute("viewBox") || "").split(/\s+/);
      const natW = parseFloat(vb[2] || "0");
      const natH = parseFloat(vb[3] || "0");
      if (!natW || !natH) continue;
      const scale = Math.min(1, Math.max(col / natW, 0.66));
      svg.style.height = "auto";
      if (scale < 1) {
        svg.style.maxWidth = "none";
        svg.style.width = `${Math.round(natW * scale)}px`;
      }
      holder.dataset.scale = String(Math.round(scale * 1000) / 1000);
      holder.style.overflowX = natW * scale > col ? "auto" : "";
    }
  }

  async function renderMermaidBlocks() {
    if (!window.mermaid) return;
    try {
      window.mermaid.initialize({
        ...state.mermaidConfig,
        startOnLoad: false,
      });
    } catch {
      // initialize is idempotent-ish; a bad config shouldn't kill the page.
    }
    let i = 0;
    for (const el of mermaidTargets()) {
      const code = el.dataset.code ?? el.textContent ?? "";
      el.dataset.code = code;
      try {
        const out = await window.mermaid.render(`aed-mmd-${Date.now()}-${i}`, code);
        i += 1;
        if (el.tagName === "PRE") {
          const holder = document.createElement("div");
          holder.className = "aed-mermaid-svg";
          holder.dataset.code = code;
          holder.innerHTML = out.svg;
          el.replaceWith(holder);
        } else {
          el.innerHTML = out.svg;
        }
      } catch {
        // Leave the block as source code on a render failure.
      }
    }
    fitMermaidSvgs();
  }

  function requestMermaidIfNeeded(root) {
    if (root.querySelectorAll("pre.mermaid").length === 0) return;
    if (window.mermaid) {
      void renderMermaidBlocks();
      return;
    }
    if (!state.mermaidRequested) {
      state.mermaidRequested = true;
      post({ type: "needMermaid" });
    }
  }

  function restoreScroll(y) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.scrollTo(0, y));
    });
  }

  function render(p) {
    state.renderId = p.renderId;
    state.path = p.path;
    if (p.mermaidConfig) state.mermaidConfig = p.mermaidConfig;
    setThemeCss(p.themeCss);
    const root = contentEl();
    if (!root) return;
    let out;
    try {
      out = globalThis.AedMarkdown.renderMarkdown(p.markdown || "");
    } catch (err) {
      root.textContent = `Markdown render failed: ${err && err.message ? err.message : err}`;
      return;
    }
    root.innerHTML = sanitize(out.html);
    decorateCodeBlocks(root);
    buildToc(out.headings);
    requestImages(root, p.renderId);
    requestMermaidIfNeeded(root);
    restoreScroll(p.scrollY || 0);
    updateCurrentHeading();
  }

  function setTheme(p) {
    setThemeCss(p.themeCss);
    if (p.mermaidConfig) state.mermaidConfig = p.mermaidConfig;
    if (window.mermaid) void renderMermaidBlocks();
  }

  function setImages(p) {
    if (!p || p.renderId !== state.renderId) return;
    const images = p.images || {};
    for (const src of Object.keys(images)) {
      const dataUrl = images[src];
      const imgs = document.querySelectorAll(`img[src="${CSS.escape(src)}"]`);
      for (const img of imgs) {
        if (dataUrl) {
          img.setAttribute("src", dataUrl);
          img.classList.remove("aed-img-missing");
        } else {
          img.removeAttribute("src");
          img.classList.add("aed-img-missing");
        }
      }
    }
  }

  function mermaidUnavailable() {
    for (const pre of document.querySelectorAll("pre.mermaid")) {
      const cap = document.createElement("p");
      cap.className = "aed-mermaid-unavailable";
      cap.textContent = "Diagram renderer unavailable offline";
      pre.after(cap);
    }
  }

  function mermaidReady() {
    void renderMermaidBlocks();
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    const a = t && t.closest ? t.closest("a") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    e.preventDefault();
    if (href.startsWith("#")) {
      scrollToId(href.slice(1));
      return;
    }
    if (href) post({ type: "link", href });
  });

  let scrollTimer = 0;
  window.addEventListener("scroll", () => {
    updateCurrentHeading();
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      post({ type: "scroll", path: state.path, y: Math.round(window.scrollY) });
    }, 200);
  });

  window.addEventListener("resize", () => {
    buildToc(state.headings);
    updateCurrentHeading();
    fitMermaidSvgs();
  });

  window.__aed = {
    render,
    setTheme,
    setImages,
    mermaidUnavailable,
    mermaidReady,
  };
}
