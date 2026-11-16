import * as fs from "fs/promises";
import { Buffer } from "buffer";
import {
  cleanup,
  computed,
  effect,
  host,
  openUrl,
  signal,
  View,
  type Accessor,
  type JSX,
  type Signal,
  type WebViewRef,
} from "nsh";
import { createLruCache, type LruCache } from "./classify";
import {
  buildPreviewThemeCss,
  imageMimeForPath,
  type PreviewBridgeDeps,
} from "./markdownPage";
import {
  buildMermaidConfig,
  buildPreloadBgScript,
  clampDiagramZoom,
  CLEAR_PRELOAD_BG_JS,
  clearTimerRef,
  createCopyFeedback,
  detectMermaidKind,
  DiagramEmptyOverlay,
  DiagramErrorBanner,
  DiagramViewportPill,
  formatDiagramRenderMessage,
  formatDiagramZoomScript,
  formatThemeSyncScript,
  loadMermaidBundleJs,
  SandboxPreviewWebView,
  settleDiagramResult,
  type TimerRef,
} from "./mermaid";
import type { EditorTheme } from "./themes";
import type { LoadedFile } from "./workspace";

export { buildPreloadBgScript };

const IMAGE_BYTES_CAP = 20 * 1024 * 1024;
const RENDER_DEBOUNCE_MS = 120;

/** Bounded per-path scroll memory for the shared preview page (in-memory only). */
const scrollMemory = createLruCache<string, number>(64);

/** Bounded `(path\0mtimeMs:size)` Base64 data URL cache so Markdown edits hit memory in O(1). */
const imageDataUrlCache = createLruCache<string, string>(32);

export interface ImageReadIo {
  stat(p: string): Promise<{ isFile(): boolean; mtimeMs: number; size: number }>;
  readFile(p: string): Promise<Uint8Array>;
}

const defaultImageIo: ImageReadIo = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p),
};

/** Read and Base64-encode a local Markdown image, caching by `${path}\0${mtimeMs}:${size}`. */
export async function readImageDataUrl(
  imagePath: string,
  cache: LruCache<string, string> = imageDataUrlCache,
  io: ImageReadIo = defaultImageIo,
): Promise<string | null> {
  const mime = imageMimeForPath(imagePath);
  if (!mime) return null;
  try {
    const stat = await io.stat(imagePath);
    if (!stat.isFile() || stat.size > IMAGE_BYTES_CAP) return null;
    const key = `${imagePath}\0${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const bytes = await io.readFile(imagePath);
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    cache.set(key, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

export interface PreviewRenderTracker {
  active: boolean;
  path: string;
  kind: string;
}

export type RenderSchedule = "skip" | "immediate" | "debounce";

function isRenderablePreview<
  T extends Pick<LoadedFile, "mode" | "classification">,
>(file: T | undefined): file is T {
  if (!file || file.mode !== "preview") return false;
  const kind = file.classification.kind;
  return kind === "markdown" || kind === "mermaid";
}

/**
 * Decide whether an update should skip (non-preview/non-md/non-mmd), render
 * immediately in `0ms` (path switch or `source -> preview`), or debounce `120ms`.
 */
export function planPreviewRender(
  prev: PreviewRenderTracker,
  file: Pick<LoadedFile, "path" | "mode" | "classification"> | undefined,
): RenderSchedule {
  if (!isRenderablePreview(file)) {
    prev.active = false;
    return "skip";
  }
  const kind = file.classification.kind;
  const immediate = !prev.active || file.path !== prev.path || kind !== prev.kind;
  prev.active = true;
  prev.path = file.path;
  prev.kind = kind;
  return immediate ? "immediate" : "debounce";
}

/** Build the page injection script for either `.md` or `.mmd` in the unified preview WebView. */
export function buildPreviewRenderScript(opts: {
  file: Pick<LoadedFile, "path" | "text" | "classification">;
  renderId: number;
  themeCss: string;
  theme: EditorTheme;
  zoomPercent: number;
  scrollY: number;
}): string {
  if (opts.file.classification.kind === "mermaid") {
    const msg = formatDiagramRenderMessage({
      renderId: opts.renderId,
      path: opts.file.path,
      code: opts.file.text,
      themeCss: opts.themeCss,
      theme: opts.theme,
    });
    return (
      CLEAR_PRELOAD_BG_JS +
      `window.__aed && window.__aed.renderDiagram(${JSON.stringify(msg)});` +
      formatDiagramZoomScript(opts.zoomPercent)
    );
  }
  const payload = {
    renderId: opts.renderId,
    path: opts.file.path,
    markdown: opts.file.text,
    themeCss: opts.themeCss,
    scrollY: opts.scrollY,
    mermaidConfig: buildMermaidConfig(opts.theme, ""),
  };
  return (
    CLEAR_PRELOAD_BG_JS +
    `window.__aed && window.__aed.render(${JSON.stringify(payload)});` +
    formatDiagramZoomScript(100)
  );
}

export interface MarkdownPreviewProps {
  file: Accessor<LoadedFile | undefined>;
  theme: Accessor<EditorTheme>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  /** Receives an already-resolved absolute path (and optional 1-based location). */
  onOpenRelativeLink: (
    resolvedPath: string,
    loc?: { line?: number; column?: number },
  ) => void;
  /** Optional external zoom signal (50–250%) for per-tab `.mmd` zoom state. */
  zoom?: Signal<number>;
}

interface MarkdownHostState {
  props: MarkdownPreviewProps;
  localZoom: Signal<number>;
  diagramError: Signal<string | null>;
  isDiagram: Accessor<boolean>;
  themeCss: Accessor<string>;
  wvRef: WebViewRef | null;
  pageReady: boolean;
  renderSeq: number;
  lastDiagramPath: string;
  renderTimer: TimerRef;
  tracker: PreviewRenderTracker;
}

function readZoomValue(state: MarkdownHostState): number {
  return state.props.zoom ? state.props.zoom() : state.localZoom();
}

function writeZoomValue(state: MarkdownHostState, next: number): void {
  if (state.props.zoom) state.props.zoom.set(next);
  else state.localZoom.set(next);
}

function syncDiagramPathZoom(state: MarkdownHostState, file: LoadedFile): void {
  if (file.classification.kind !== "mermaid" || file.path === state.lastDiagramPath) {
    return;
  }
  state.lastDiagramPath = file.path;
  if (!state.props.zoom) state.localZoom.set(100);
}

function sendHostRender(state: MarkdownHostState): void {
  if (!state.wvRef || !state.pageReady) return;
  const f = state.props.file();
  if (!isRenderablePreview(f)) return;
  syncDiagramPathZoom(state, f);
  state.diagramError.set(null);
  state.renderSeq += 1;
  state.wvRef.injectJavaScript(
    buildPreviewRenderScript({
      file: f,
      renderId: state.renderSeq,
      themeCss: state.themeCss(),
      theme: state.props.theme(),
      zoomPercent: readZoomValue(state),
      scrollY: scrollMemory.get(f.path) ?? 0,
    }),
  );
}

function applyHostZoom(state: MarkdownHostState, next: number): void {
  const clamped = clampDiagramZoom(next);
  writeZoomValue(state, clamped);
  state.wvRef?.injectJavaScript(formatDiagramZoomScript(clamped));
}

function bindHostRenderEffect(state: MarkdownHostState): void {
  effect(() => {
    const f = state.props.file();
    const action = planPreviewRender(state.tracker, f);
    clearTimerRef(state.renderTimer);
    if (action === "skip") return;
    void f!.text;
    if (action === "immediate") sendHostRender(state);
    else state.renderTimer.id = setTimeout(() => sendHostRender(state), RENDER_DEBOUNCE_MS);
  });
}

function bindHostThemeEffect(state: MarkdownHostState): void {
  effect(() => {
    const css = state.themeCss();
    if (!state.wvRef || !state.pageReady) return;
    state.wvRef.injectJavaScript(
      formatThemeSyncScript(css, buildMermaidConfig(state.props.theme(), "")),
    );
  });
}

function bindDebugEvalListener(getRef: () => WebViewRef | null): void {
  const offEval = host.on("aed.preview.eval", (d) => {
    const js = (d as { js?: unknown } | null)?.js;
    if (typeof js === "string") getRef()?.injectJavaScript(js);
  });
  cleanup(() => offEval?.());
}

function createHostBridgeDeps(
  state: MarkdownHostState,
  onCopy: () => void,
): PreviewBridgeDeps {
  return {
    basePath: () => state.props.file()?.path ?? "",
    openUrl: (url) => {
      void openUrl(url);
    },
    openFile: (p, loc) => state.props.onOpenRelativeLink(p, loc),
    readImageDataUrl: (p) => readImageDataUrl(p),
    inject: (js) => state.wvRef?.injectJavaScript(js),
    loadMermaidJs: loadMermaidBundleJs,
    rememberScroll: (p, y) => scrollMemory.set(p, y),
    currentRenderId: () => state.renderSeq,
    mermaidConfig: () => buildMermaidConfig(state.props.theme(), ""),
    onDiagramRendered: (res) => {
      if (!state.isDiagram()) return;
      settleDiagramResult(state.diagramError, state.wvRef, readZoomValue(state), res);
    },
    onCopySource: onCopy,
  };
}

function isEmptyMermaidFile(file: LoadedFile | undefined): boolean {
  if (!file || file.classification.kind !== "mermaid") return false;
  return file.text.trim().length === 0;
}

/** Single sandboxed vector preview host serving both `.md` documents and `.mmd` diagrams. */
export function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  const isDiagram = computed(() => props.file()?.classification.kind === "mermaid");
  const isEmptyDiagram = computed(() => isEmptyMermaidFile(props.file()));
  const kindLabel = computed(() => detectMermaidKind(props.file()?.text ?? ""));
  const themeCss = computed(() =>
    buildPreviewThemeCss(props.theme(), props.fontStyle()),
  );
  const copyFeedback = createCopyFeedback(() => props.file()?.text ?? "");

  const state: MarkdownHostState = {
    props,
    localZoom: signal(100),
    diagramError: signal<string | null>(null),
    isDiagram,
    themeCss,
    wvRef: null,
    pageReady: false,
    renderSeq: 0,
    lastDiagramPath: "",
    renderTimer: { id: null },
    tracker: { active: false, path: "", kind: "" },
  };

  cleanup(() => clearTimerRef(state.renderTimer));
  bindHostRenderEffect(state);
  bindHostThemeEffect(state);
  bindDebugEvalListener(() => state.wvRef);

  const deps = createHostBridgeDeps(state, copyFeedback.copy);
  const activeZoom = () => readZoomValue(state);

  return (
    <View
      testID={isDiagram() ? "preview-mermaid" : "preview-markdown"}
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1 relative"
    >
      <If when={isDiagram()}>
        <DiagramErrorBanner error={state.diagramError} theme={props.theme} />
      </If>
      <SandboxPreviewWebView
        theme={props.theme}
        deps={deps}
        onRef={(r) => {
          state.wvRef = r;
        }}
        onReady={() => {
          state.pageReady = true;
          sendHostRender(state);
        }}
        onDebugMessage={(payload) => host.post("aedPreviewDebug", payload)}
      />
      <DiagramEmptyOverlay visible={isEmptyDiagram} theme={props.theme} />
      <If when={isDiagram()}>
        <DiagramViewportPill
          kindLabel={kindLabel}
          zoom={activeZoom}
          copied={copyFeedback.copied}
          theme={props.theme}
          onZoomDelta={(d) => applyHostZoom(state, activeZoom() + d)}
          onZoomReset={() => applyHostZoom(state, 100)}
          onCopy={copyFeedback.copy}
        />
      </If>
    </View>
  );
}
