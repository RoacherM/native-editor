import { Buffer } from "buffer";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  Clipboard,
  colorScheme,
  computed,
  effect,
  Image,
  Scroll,
  signal,
  Text,
  View,
  WebView,
  type Accessor,
  type JSX,
  type WebViewRef,
} from "nsh";
import { Button } from "nsh/base";
import { createBlobUrl } from "./classify";
import { Icon } from "./icons";

export interface MermaidRenderResult {
  blobUrl: string;
  width: number;
  height: number;
}

interface PendingJob {
  id: number;
  code: string;
  theme: "dark" | "light";
  fontFamily: string;
  resolve: (res: MermaidRenderResult) => void;
  reject: (err: Error) => void;
}

interface WorkerMessage {
  type: "ready" | "rendered";
  id?: number;
  ok?: boolean;
  pngBase64?: string;
  width?: number;
  height?: number;
  error?: string;
}

const CACHE_DIR = "/tmp/native-editor-mermaid";
const CACHED_BUNDLE_PATH = `${CACHE_DIR}/mermaid-docu-bundle.js`;
const MERMAID_START_MARKER = "var __esbuild_esm_mermaid_nm;";
const MERMAID_END_MARKER =
  'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;';

const renderCache = new Map<string, MermaidRenderResult>();
const inflightRequests = new Map<string, Promise<MermaidRenderResult>>();
const pendingQueue: PendingJob[] = [];
const activeJobs = new Map<number, PendingJob>();

const workerHtmlSignal = signal<string>("");
let activeWebViewRef: WebViewRef | null = null;
let workerReady = false;
let jobCounter = 0;
let initStarted = false;

/** Extract a concise diagram type badge (e.g. "flowchart TB", "sequenceDiagram") from Mermaid source. */
export function detectMermaidKind(code: string): string {
  const lines = code.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    const match = trimmed.match(
      /^(flowchart(?:\s+[A-Z]{2})?|graph(?:\s+[A-Z]{2})?|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey|quadrantChart|xychart-beta)/
    );
    return match ? match[1] : "mermaid";
  }
  return "mermaid";
}

/** Normalize escaped newlines and multiline double-quoted node labels into <br/> for Mermaid HTML layout. */
export function preprocessMermaidCode(raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, "<br/>");
  return trimmed.replace(/"([^"]*)"/g, (_, inner: string) => {
    const joined = inner.replace(/\r?\n[ \t]*/g, "<br/>");
    return `"${joined}"`;
  });
}

function extractInlineMermaidFromHtml(html: string): string | null {
  const start = html.indexOf(MERMAID_START_MARKER);
  if (start < 0) return null;
  const end = html.indexOf(MERMAID_END_MARKER, start);
  if (end < 0) return null;
  return html.slice(start, end + MERMAID_END_MARKER.length);
}

async function tryReadCachedBundle(): Promise<string | null> {
  try {
    const text = await fs.readFile(CACHED_BUNDLE_PATH, "utf8");
    return text.length > 1000 ? text : null;
  } catch {
    return null;
  }
}

async function readMermaidFromDocuMd(
  extRoot: string,
  entry: string
): Promise<string | null> {
  if (!entry.startsWith("xicilion.markdown-viewer-extension-")) return null;
  const htmlPath = path.join(extRoot, entry, "webview", "iframe-render.html");
  const html = await fs.readFile(htmlPath, "utf8");
  return extractInlineMermaidFromHtml(html);
}

async function scanExtensionRoot(extRoot: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(extRoot);
    for (const entry of entries) {
      const found = await readMermaidFromDocuMd(extRoot, entry);
      if (found) return found;
    }
  } catch {
    // Ignore missing extension directory.
  }
  return null;
}

async function loadMermaidBundleJs(): Promise<string | null> {
  const cached = await tryReadCachedBundle();
  if (cached) return cached;

  const home = os.homedir();
  const roots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".antigravity", "extensions"),
  ];

  for (const root of roots) {
    const found = await scanExtensionRoot(root);
    if (found) {
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(CACHED_BUNDLE_PATH, found);
      } catch {
        // Best-effort cache write.
      }
      return found;
    }
  }
  return null;
}

function buildWorkerRuntimeScript(): string {
  return `
function parseSvgLines(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\\n"));
  clone.querySelectorAll("p, div, li").forEach((blk, i) => {
    if (i > 0) blk.prepend("\\n");
  });
  return (clone.textContent || "")
    .split(/\\r?\\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveLegibleTextColor(raw, isDark, fallback) {
  if (!raw || raw === "none" || raw === "rgba(0, 0, 0, 0)" || raw === "transparent") {
    return fallback;
  }
  if (
    isDark &&
    (raw === "rgb(0, 0, 0)" ||
      raw === "rgb(51, 51, 51)" ||
      raw === "#000" ||
      raw === "#000000" ||
      raw === "#333" ||
      raw === "#333333")
  ) {
    return fallback;
  }
  return raw;
}

function inlineForeignObjects(svgEl, isDark) {
  const ns = "http://www.w3.org/2000/svg";
  const defaultColor = isDark ? "#f1f5f9" : "#1f2937";
  const edgeBg = isDark ? "#18181b" : "#f8fafc";
  svgEl.querySelectorAll("foreignObject").forEach((fo) => {
    const lines = parseSvgLines(fo);
    if (lines.length === 0) {
      fo.remove();
      return;
    }
    const x = parseFloat(fo.getAttribute("x") || "0") || 0;
    const y = parseFloat(fo.getAttribute("y") || "0") || 0;
    const w = parseFloat(fo.getAttribute("width") || "0") || fo.clientWidth || 140;
    const h = parseFloat(fo.getAttribute("height") || "0") || fo.clientHeight || 36;
    const targetEl = fo.querySelector(".nodeLabel, .edgeLabel, .cluster-label, span, div") || fo;
    const cs = window.getComputedStyle(targetEl);
    const fontSize = parseFloat(cs.fontSize || "13.5") || 13.5;
    const lineHeight = fontSize * 1.32;
    const color = resolveLegibleTextColor(cs.color, isDark, defaultColor);
    const fontFamily = cs.fontFamily || '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const fontWeight = cs.fontWeight || "500";
    const g = document.createElementNS(ns, "g");
    if (fo.closest(".edgeLabel")) {
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(x - 4));
      rect.setAttribute("y", String(y - 2));
      rect.setAttribute("width", String(w + 8));
      rect.setAttribute("height", String(h + 4));
      rect.setAttribute("rx", "4");
      rect.setAttribute("fill", edgeBg);
      rect.setAttribute("fill-opacity", "0.92");
      g.appendChild(rect);
    }
    const textEl = document.createElementNS(ns, "text");
    const cx = x + w / 2;
    const cy = y + h / 2;
    textEl.setAttribute("x", String(cx));
    textEl.setAttribute("y", String(cy));
    textEl.setAttribute("text-anchor", "middle");
    textEl.setAttribute("dominant-baseline", "central");
    textEl.setAttribute("fill", color);
    textEl.setAttribute("font-family", fontFamily);
    textEl.setAttribute("font-size", fontSize + "px");
    textEl.setAttribute("font-weight", fontWeight);
    lines.forEach((line, idx) => {
      const tspan = document.createElementNS(ns, "tspan");
      const lineY = cy + (idx - (lines.length - 1) / 2) * lineHeight;
      tspan.setAttribute("x", String(cx));
      tspan.setAttribute("y", String(lineY));
      tspan.setAttribute("dominant-baseline", "central");
      tspan.textContent = line;
      textEl.appendChild(tspan);
    });
    g.appendChild(textEl);
    fo.replaceWith(g);
  });
}

function inlineExistingTextStyles(svgEl, isDark) {
  const fallback = isDark ? "#f1f5f9" : "#1f2937";
  svgEl.querySelectorAll("text").forEach((t) => {
    const cs = window.getComputedStyle(t);
    const existingFill = t.getAttribute("fill");
    t.setAttribute("fill", resolveLegibleTextColor(existingFill || cs.fill, isDark, fallback));
    if (!t.getAttribute("font-family") && cs.fontFamily) {
      t.setAttribute("font-family", cs.fontFamily);
    }
    if (!t.getAttribute("font-size") && cs.fontSize) {
      t.setAttribute("font-size", cs.fontSize);
    }
  });
}

function rasterizeSvgToPng(svgEl) {
  return new Promise((resolve, reject) => {
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    let vx = vb && vb.width ? vb.x : 0;
    let vy = vb && vb.height ? vb.y : 0;
    let vw = vb && vb.width ? vb.width : svgEl.clientWidth || 640;
    let vh = vb && vb.height ? vb.height : svgEl.clientHeight || 360;
    try {
      const bb = svgEl.getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        const minX = Math.min(vx, bb.x);
        const minY = Math.min(vy, bb.y);
        const maxX = Math.max(vx + vw, bb.x + bb.width);
        const maxY = Math.max(vy + vh, bb.y + bb.height);
        vx = minX;
        vy = minY;
        vw = maxX - minX;
        vh = maxY - minY;
      }
    } catch (_) {}
    const pad = 16;
    vx -= pad;
    vy -= pad;
    vw = Math.max(64, Math.ceil(vw + pad * 2));
    vh = Math.max(48, Math.ceil(vh + pad * 2));
    svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svgEl.setAttribute("viewBox", vx + " " + vy + " " + vw + " " + vh);
    svgEl.setAttribute("width", String(vw));
    svgEl.setAttribute("height", String(vh));
    svgEl.style.maxWidth = "none";
    const xml = new XMLSerializer().serializeToString(svgEl);
    const b64 = btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(2, 3840 / Math.max(vw, vh, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, vw, vh);
      const dataUrl = canvas.toDataURL("image/png");
      resolve({
        pngBase64: dataUrl.replace(/^data:image\\/png;base64,/, ""),
        width: vw,
        height: vh,
      });
    };
    img.onerror = () => reject(new Error("SVG image rasterization failed"));
    img.src = "data:image/svg+xml;base64," + b64;
  });
}

window.__nshRenderMermaid = async function(req) {
  const stage = document.getElementById("stage");
  try {
    const isDark = req.theme !== "light";
    const font = (req.fontFamily ? req.fontFamily + ", " : "") +
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: isDark ? "dark" : "default",
      look: "classic",
      fontFamily: font,
      flowchart: { htmlLabels: true, curve: "basis", padding: 14 },
      sequence: { useMaxWidth: false },
      themeVariables: isDark ? {
        fontFamily: font,
        fontSize: "13.5px",
        background: "transparent",
        primaryColor: "#1e293b",
        primaryTextColor: "#e2e8f0",
        primaryBorderColor: "#475569",
        lineColor: "#94a3b8",
        secondaryColor: "#1e1b4b",
        tertiaryColor: "#0f172a",
        clusterBkg: "#111827",
        clusterBorder: "#374151",
      } : {
        fontFamily: font,
        fontSize: "13.5px",
        background: "transparent",
      },
    });
    const out = await mermaid.render("nsh-mmd-" + req.id, req.code);
    stage.innerHTML = out.svg;
    const svgEl = stage.querySelector("svg");
    if (!svgEl) throw new Error("Mermaid did not produce an SVG element");
    inlineForeignObjects(svgEl, isDark);
    inlineExistingTextStyles(svgEl, isDark);
    const png = await rasterizeSvgToPng(svgEl);
    stage.innerHTML = "";
    window.nsh.postMessage(JSON.stringify({
      type: "rendered",
      id: req.id,
      ok: true,
      pngBase64: png.pngBase64,
      width: png.width,
      height: png.height,
    }));
  } catch (err) {
    stage.innerHTML = "";
    window.nsh.postMessage(JSON.stringify({
      type: "rendered",
      id: req.id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    }));
  }
};

window.addEventListener("load", () => {
  if (window.nsh && window.nsh.postMessage) {
    window.nsh.postMessage(JSON.stringify({ type: "ready" }));
  }
});
`;
}

function buildWorkerHtml(bundleJs: string | null): string {
  const scriptTag = bundleJs
    ? `<script>${bundleJs}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  #stage { position: absolute; left: 0; top: 0; width: 2400px; visibility: hidden; pointer-events: none; }
</style>
${scriptTag}
</head>
<body>
<div id="stage"></div>
<script>${buildWorkerRuntimeScript()}</script>
</body>
</html>`;
}

function flushPendingJobs(): void {
  if (!workerReady || !activeWebViewRef) return;
  while (pendingQueue.length > 0) {
    const job = pendingQueue.shift()!;
    activeJobs.set(job.id, job);
    const payload = JSON.stringify({
      id: job.id,
      code: job.code,
      theme: job.theme,
      fontFamily: job.fontFamily,
    });
    activeWebViewRef.injectJavaScript(`window.__nshRenderMermaid(${payload});`);
  }
}

function handleRenderedMessage(msg: WorkerMessage): void {
  if (msg.id == null) return;
  const job = activeJobs.get(msg.id);
  if (!job) return;
  activeJobs.delete(msg.id);

  if (msg.ok && msg.pngBase64) {
    const bytes = new Uint8Array(Buffer.from(msg.pngBase64, "base64"));
    const result: MermaidRenderResult = {
      blobUrl: createBlobUrl(bytes, "image/png"),
      width: msg.width ?? 640,
      height: msg.height ?? 360,
    };
    job.resolve(result);
  } else {
    job.reject(new Error(msg.error || "Mermaid render failed"));
  }
}

function handleWorkerMessage(rawData: string): void {
  try {
    const msg = JSON.parse(rawData) as WorkerMessage;
    if (msg.type === "ready") {
      workerReady = true;
      flushPendingJobs();
    } else if (msg.type === "rendered") {
      handleRenderedMessage(msg);
    }
  } catch {
    // Ignore malformed messages.
  }
}

function ensureWorkerInitialized(): void {
  if (initStarted) return;
  initStarted = true;
  void loadMermaidBundleJs().then((bundle) => {
    workerHtmlSignal.set(buildWorkerHtml(bundle));
  });
}

/** Render Mermaid diagram source into a Retina PNG blob: URL via the hidden WebKit host. */
export function requestMermaidRender(
  rawCode: string,
  theme: "dark" | "light",
  fontFamily = ""
): Promise<MermaidRenderResult> {
  ensureWorkerInitialized();
  const normalized = preprocessMermaidCode(rawCode);
  const cacheKey = `${theme}:${fontFamily}:${normalized}`;
  const cached = renderCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const existing = inflightRequests.get(cacheKey);
  if (existing) return existing;

  const promise = new Promise<MermaidRenderResult>((resolve, reject) => {
    jobCounter += 1;
    pendingQueue.push({
      id: jobCounter,
      code: normalized,
      theme,
      fontFamily,
      resolve: (res) => {
        renderCache.set(cacheKey, res);
        inflightRequests.delete(cacheKey);
        resolve(res);
      },
      reject: (err) => {
        inflightRequests.delete(cacheKey);
        reject(err);
      },
    });
    flushPendingJobs();
  });

  inflightRequests.set(cacheKey, promise);
  return promise;
}

/** Hidden offscreen WebView host that executes Mermaid layout and PNG rasterization. */
export function MermaidRendererHost(): JSX.Element {
  effect(() => {
    ensureWorkerInitialized();
  });

  return (
    <If when={workerHtmlSignal().length > 0}>
      <View
        style={{
          position: "absolute",
          left: -10000,
          top: -10000,
          width: 1280,
          height: 900,
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        <WebView
          ref={(r) => {
            activeWebViewRef = r;
            if (!r) workerReady = false;
          }}
          html={workerHtmlSignal()}
          onMessage={({ data }) => handleWorkerMessage(data)}
          style={{ width: 1280, height: 900 }}
        />
      </View>
    </If>
  );
}

/** Interactive Mermaid diagram block with zoom controls and Diagram/Code toggle (inspired by docu.md). */
export function MermaidDiagramBlock(props: {
  code: string | Accessor<string>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
}): JSX.Element {
  const rawCode = computed(() =>
    typeof props.code === "function" ? props.code() : props.code
  );
  const kindLabel = computed(() => detectMermaidKind(rawCode()));
  const zoom = signal(100);
  const showCode = signal(false);
  const copied = signal(false);
  const rendered = signal<MermaidRenderResult | null>(null);
  const errorMsg = signal<string | null>(null);
  const clampZoom = (next: number) => Math.max(50, Math.min(250, next));

  const copySource = () => {
    void Clipboard.writeText(rawCode().trim()).then(() => {
      copied.set(true);
      setTimeout(() => copied.set(false), 1500);
    });
  };

  effect(() => {
    const code = rawCode();
    const scheme = colorScheme() === "light" ? "light" : "dark";
    const font = props.fontStyle().fontFamily ?? "";
    errorMsg.set(null);
    void requestMermaidRender(code, scheme, font)
      .then((res) => {
        rendered.set(res);
      })
      .catch((err: unknown) => {
        errorMsg.set(err instanceof Error ? err.message : String(err));
      });
  });

  const displayDimensions = computed(() => {
    const res = rendered();
    if (!res) return { width: 640, height: 220 };
    const fitScale = Math.min(1, 880 / Math.max(res.width, 1));
    const factor = fitScale * (zoom() / 100);
    return {
      width: Math.max(120, Math.round(res.width * factor)),
      height: Math.max(80, Math.round(res.height * factor)),
    };
  });

  return (
    <View
      testID="mermaid-block"
      class="w-full my-3 rounded-lg border border-border bg-card/40 overflow-hidden"
    >
      <View class="h-7 px-3 bg-muted/40 border-b border-border flex-row items-center justify-between select-none">
        <View class="flex-row items-center gap-2">
          <Text class="text-[10.5px] font-mono font-bold text-teal-400">
            MERMAID
          </Text>
          <Text class="text-[10.5px] font-mono text-muted-foreground">
            {kindLabel()}
          </Text>
        </View>
        <View class="flex-row items-center gap-1">
          <If when={!showCode()}>
            <View class="flex-row items-center gap-1 mr-1">
              <Button
                testID="mermaid-zoom-out"
                onPress={() => zoom.update((z) => clampZoom(z - 25))}
                class="h-5 w-5 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border-none shadow-none p-0"
              >
                <Icon name="zoom-out" size={10.5} tint="#cccccc" />
              </Button>
              <Button
                testID="mermaid-zoom-reset"
                onPress={() => zoom.set(100)}
                class="h-5 px-1.5 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border-none shadow-none"
              >
                <Text class="text-[10px] font-mono text-secondary-foreground">
                  {`${zoom()}%`}
                </Text>
              </Button>
              <Button
                testID="mermaid-zoom-in"
                onPress={() => zoom.update((z) => clampZoom(z + 25))}
                class="h-5 w-5 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border-none shadow-none p-0"
              >
                <Icon name="zoom-in" size={10.5} tint="#cccccc" />
              </Button>
            </View>
          </If>
          <Button
            testID="mermaid-copy-code"
            onPress={copySource}
            class="h-5 px-2 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border-none shadow-none"
          >
            <Text class="text-[10.5px] text-secondary-foreground font-medium">
              {copied() ? "Copied" : "Copy"}
            </Text>
          </Button>
          <Button
            testID="mermaid-toggle-code"
            onPress={() => showCode.update((v) => !v)}
            class="h-5 px-2 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border-none shadow-none"
          >
            <Text class="text-[10.5px] text-secondary-foreground font-medium">
              {showCode() ? "Diagram" : "Code"}
            </Text>
          </Button>
        </View>
      </View>

      <If when={showCode() || !!errorMsg()}>
        <View class="p-3.5 bg-background/80 gap-2">
          <If when={errorMsg()}>
            {(err) => (
              <Text class="text-xs font-mono text-destructive">{err()}</Text>
            )}
          </If>
          <Text
            testID="mermaid-code-view"
            style={props.fontStyle()}
            class="select-text text-xs font-mono text-foreground"
          >
            {rawCode().trim()}
          </Text>
        </View>
      </If>

      <If when={!showCode() && !errorMsg()}>
        <View class="w-full items-center justify-center p-4 bg-background/30">
          <If when={rendered()}>
            {(res) => (
              <Scroll horizontal class="w-full">
                <View class="min-w-full items-center justify-center">
                  <Image
                    testID="mermaid-diagram-image"
                    src={res().blobUrl}
                    style={{
                      width: displayDimensions().width,
                      height: displayDimensions().height,
                      objectFit: "contain",
                    }}
                  />
                </View>
              </Scroll>
            )}
          </If>
          <If when={!rendered()}>
            <View
              testID="mermaid-loading"
              class="w-full py-6 items-center justify-center gap-1.5"
            >
              <Text class="text-xs font-mono text-muted-foreground">
                {`Rendering ${kindLabel()} diagram...`}
              </Text>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
