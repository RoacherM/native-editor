import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  Clipboard,
  cleanup,
  colorScheme,
  computed,
  effect,
  signal,
  Text,
  untracked,
  View,
  WebView,
  type Accessor,
  type JSX,
  type Signal,
  type WebViewRef,
} from "nsh";
import { Button } from "nsh/base";
import { Icon } from "./icons";
import {
  buildPreviewShellHtml,
  buildPreviewThemeCss,
  handlePreviewMessage,
  parsePreviewMessage,
  type PreviewBridgeDeps,
} from "./markdownPage";
import { MARKDOWN_RUNTIME_JS } from "./markdownVendor.generated";
import { EDITOR_THEMES, type EditorTheme } from "./themes";

// DESIGN.md「文件预览与 Mermaid 渲染契约」
const MERMAID_START_MARKER = "var __esbuild_esm_mermaid_nm;";
const MERMAID_END_MARKER =
  'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;';
const KIND_RE =
  /^(flowchart(?:\s+[A-Z]{2})?|graph(?:\s+[A-Z]{2})?|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey|quadrantChart|xychart-beta)/;

let cachedShellHtml: string | null = null;
let bundleLookup: Promise<string | null> | null = null;

export function hasCachedPreviewShellHtml(): boolean {
  return cachedShellHtml !== null;
}

/** Lazily materialize and memoize the zero-script CSP shell page on first preview mount. */
export function getPreviewShellHtml(): string {
  cachedShellHtml ??= buildPreviewShellHtml();
  return cachedShellHtml;
}

/** Paint theme background before first document paint to eliminate initial white flash. */
export function buildPreloadBgScript(background: string): string {
  return `document.documentElement.style.background=${JSON.stringify(background)};document.body&&(document.body.style.background='transparent');`;
}

export function clampDiagramZoom(zoomPercent: number): number {
  return Math.max(50, Math.min(250, zoomPercent));
}

/** Extract a concise diagram badge (e.g. `"flowchart TB"`, `"sequenceDiagram"`) from Mermaid source. */
export function detectMermaidKind(code: string): string {
  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    const match = KIND_RE.exec(trimmed);
    return match ? match[1] : "mermaid";
  }
  return "mermaid";
}

/** Normalize escaped newlines and multiline double-quoted node labels into `<br/>`. */
export function preprocessMermaidCode(raw: string): string {
  return raw
    .trim()
    .replace(/\\n/g, "<br/>")
    .replace(/"([^"]*)"/g, (_, inner: string) => `"${inner.replace(/\r?\n[ \t]*/g, "<br/>")}"`);
}

/** Slice only the inline Mermaid bundle from a `docu.md` HTML file, detaching the outer string. */
export function extractInlineMermaidFromHtml(html: string): string | null {
  const start = html.indexOf(MERMAID_START_MARKER);
  if (start < 0) return null;
  const end = html.indexOf(MERMAID_END_MARKER, start);
  return end < 0 ? null : ["", html.slice(start, end + MERMAID_END_MARKER.length)].join("");
}

export interface ExtensionScanIo {
  readdir(dirPath: string): Promise<string[]>;
  readFileUtf8(filePath: string): Promise<string>;
}

const defaultScanIo: ExtensionScanIo = {
  readdir: (d) => fs.readdir(d),
  readFileUtf8: (f) => fs.readFile(f, "utf8"),
};

async function readMermaidFromDocuMd(
  extRoot: string,
  entry: string,
  io: ExtensionScanIo,
): Promise<string | null> {
  if (!entry.startsWith("xicilion.markdown-viewer-extension-")) return null;
  try {
    let html: string | null = await io.readFileUtf8(
      path.join(extRoot, entry, "webview", "iframe-render.html"),
    );
    const extracted = extractInlineMermaidFromHtml(html);
    html = null;
    return extracted;
  } catch {
    return null;
  }
}

async function scanExtensionRoot(extRoot: string, io: ExtensionScanIo): Promise<string | null> {
  let entries: string[];
  try {
    entries = await io.readdir(extRoot);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.startsWith("xicilion.markdown-viewer-extension-"))
    .sort()
    .reverse();
  for (const entry of candidates) {
    const found = await readMermaidFromDocuMd(extRoot, entry, io);
    if (found) return found;
  }
  return null;
}

/** Scan editor extension directories for an offline Mermaid JS bundle. */
export async function findMermaidBundleJs(
  roots?: readonly string[],
  io: ExtensionScanIo = defaultScanIo,
): Promise<string | null> {
  const home = os.homedir();
  const list = roots ?? [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".antigravity", "extensions"),
  ];
  for (const root of list) {
    const found = await scanExtensionRoot(root, io);
    if (found) return found;
  }
  return null;
}

/** Mermaid's JS from an installed editor extension, resolved once per process in memory. */
export function loadMermaidBundleJs(): Promise<string | null> {
  bundleLookup ??= findMermaidBundleJs();
  return bundleLookup;
}

export interface MermaidInitConfig {
  startOnLoad: boolean;
  securityLevel: string;
  theme: string;
  look: string;
  fontFamily: string;
  flowchart: { htmlLabels: boolean; curve: string; padding: number };
  sequence: { useMaxWidth: boolean };
  themeVariables: Record<string, unknown>;
}

/** Shared `mermaid.initialize(...)` config for both `.md` fences and standalone `.mmd` previews. */
export function buildMermaidConfig(theme: EditorTheme, fontFamily: string): MermaidInitConfig {
  const ui = theme.ui;
  const font =
    (fontFamily ? `${fontFamily}, ` : "") +
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif';
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    look: "classic",
    fontFamily: font,
    flowchart: { htmlLabels: true, curve: "basis", padding: 14 },
    sequence: { useMaxWidth: false },
    themeVariables: {
      darkMode: theme.appearance !== "light",
      fontFamily: font,
      fontSize: "13px",
      background: "transparent",
      primaryColor: ui.card,
      primaryTextColor: ui.foreground,
      primaryBorderColor: ui.border,
      lineColor: ui.mutedForeground,
      secondaryColor: ui.sidebar,
      tertiaryColor: ui.background,
      clusterBkg: ui.sidebar,
      clusterBorder: ui.border,
      edgeLabelBackground: ui.card,
      actorBkg: ui.card,
      actorBorder: ui.border,
      actorTextColor: ui.foreground,
      signalColor: ui.foreground,
      noteBkgColor: ui.sidebar,
      noteTextColor: ui.foreground,
      noteBorderColor: ui.border,
    },
  };
}

export interface DiagramRenderMessage {
  type: "renderDiagram";
  renderId: number;
  path: string;
  code: string;
  themeCss: string;
  mermaidConfig: MermaidInitConfig;
}

export function formatDiagramRenderMessage(opts: {
  renderId: number;
  path?: string;
  code: string;
  themeCss: string;
  theme: EditorTheme;
  fontFamily?: string;
}): DiagramRenderMessage {
  return {
    type: "renderDiagram",
    renderId: opts.renderId,
    path: opts.path ?? "",
    code: opts.code,
    themeCss: opts.themeCss,
    mermaidConfig: buildMermaidConfig(opts.theme, opts.fontFamily ?? ""),
  };
}

export const CLEAR_PRELOAD_BG_JS = 'document.documentElement.style.background="";';

export function formatThemeSyncScript(
  themeCss: string,
  mermaidConfig: MermaidInitConfig,
): string {
  return (
    CLEAR_PRELOAD_BG_JS +
    `window.__aed && window.__aed.setTheme(${JSON.stringify({ themeCss, mermaidConfig })});`
  );
}

export function formatDiagramZoomScript(zoomPercent: number): string {
  const clamped = clampDiagramZoom(zoomPercent);
  const value = clamped === 100 ? "" : String(clamped / 100);
  return `(function(z){var c=document.getElementById("aed-content");if(!c)return;c.style.zoom=document.body.classList.contains("aed-diagram-only")?z:"";})(${JSON.stringify(value)});`;
}

// Compatibility helpers retained for existing callers until Wave 2B cleanup.
export function requeueOrphanedJobs<T>(active: Map<number, T>, pending: T[]): void {
  pending.unshift(...active.values());
  active.clear();
}

export function takeJob<T extends { id: number }>(
  id: number,
  active: Map<number, T>,
  pending: T[],
): T | undefined {
  const job = active.get(id);
  if (job) {
    active.delete(id);
    return job;
  }
  const idx = pending.findIndex((p) => p.id === id);
  return idx >= 0 ? pending.splice(idx, 1)[0] : undefined;
}

export function planJobTimeout<T extends { id: number; generation: number }>(
  id: number,
  active: Map<number, T>,
  pending: T[],
  currentGeneration: number,
): { job: T | undefined; dropWorker: boolean } {
  const job = takeJob(id, active, pending);
  return { job, dropWorker: job !== undefined && job.generation === currentGeneration };
}

export function rememberRender<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  max: number,
  evict: (value: T) => void,
): void {
  cache.delete(key);
  cache.set(key, value);
  for (const [oldKey, oldValue] of cache) {
    if (cache.size <= max) break;
    cache.delete(oldKey);
    evict(oldValue);
  }
}

export function followLatest<T>(sink: {
  start: () => void;
  done: (value: T) => void;
  fail: (err: unknown) => void;
}): (pending: Promise<T>) => void {
  let latest = 0;
  return (pending) => {
    const mine = ++latest;
    sink.start();
    pending.then(
      (v) => {
        if (mine === latest) sink.done(v);
      },
      (e: unknown) => {
        if (mine === latest) sink.fail(e);
      },
    );
  };
}

/** Zero-cost compatibility stub: the 2nd offscreen `1280x900` WKWebView is retired. */
export function MermaidRendererHost(): JSX.Element | null {
  return null;
}

export interface TimerRef {
  id: ReturnType<typeof setTimeout> | null;
}

export function clearTimerRef(ref: TimerRef): void {
  if (ref.id !== null) {
    clearTimeout(ref.id);
    ref.id = null;
  }
}

export function settleDiagramResult(
  errorSignal: Signal<string | null>,
  wvRef: WebViewRef | null,
  zoomPercent: number,
  res: { ok: boolean; error?: string },
): void {
  errorSignal.set(res.ok ? null : res.error || "Diagram render failed");
  if (res.ok) wvRef?.injectJavaScript(formatDiagramZoomScript(zoomPercent));
}

export function createCopyFeedback(getText: () => string): {
  copied: Accessor<boolean>;
  copy: () => void;
} {
  const copied = signal(false);
  const timer: TimerRef = { id: null };
  cleanup(() => clearTimerRef(timer));
  const copy = () => {
    void Clipboard.writeText(getText().trim()).then(() => {
      copied.set(true);
      clearTimerRef(timer);
      timer.id = setTimeout(() => {
        timer.id = null;
        copied.set(false);
      }, 1200);
    });
  };
  return { copied, copy };
}

function dispatchWebViewMessage(
  rawData: string,
  deps: PreviewBridgeDeps,
  onDebugMessage?: (payload: string) => void,
): void {
  if (onDebugMessage && rawData.startsWith("__dbg:")) {
    onDebugMessage(rawData.slice(6));
    return;
  }
  const msg = parsePreviewMessage(rawData);
  if (msg) void handlePreviewMessage(msg, deps);
}

/** Shared sandboxed zero-script CSP `<WebView>` host for `.md` and `.mmd` vector previews. */
export function SandboxPreviewWebView(props: {
  theme: Accessor<EditorTheme>;
  deps: PreviewBridgeDeps;
  onRef: (ref: WebViewRef | null) => void;
  onReady: (ref: WebViewRef) => void;
  onDebugMessage?: (payload: string) => void;
}): JSX.Element {
  const shellHtml = getPreviewShellHtml();
  const preloadJs = buildPreloadBgScript(untracked(() => props.theme().ui.background));
  let localRef: WebViewRef | null = null;
  return (
    <WebView
      ref={(r) => {
        localRef = r;
        props.onRef(r);
      }}
      html={shellHtml}
      injectedJavaScriptBeforeContentLoaded={preloadJs}
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1"
      onLoad={() => {
        if (!localRef) return;
        localRef.injectJavaScript(MARKDOWN_RUNTIME_JS);
        props.onReady(localRef);
      }}
      onMessage={({ data }) => dispatchWebViewMessage(data, props.deps, props.onDebugMessage)}
    />
  );
}

export function DiagramErrorBanner(props: {
  error: Accessor<string | null>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <If when={props.error()}>
      {(err) => (
        <View
          testID="mermaid-error-banner"
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="px-3 py-2 shrink-0"
        >
          <Text style={{ color: props.theme().ui.accent }} class="text-xs font-mono select-text">
            {err()}
          </Text>
        </View>
      )}
    </If>
  );
}

export function DiagramEmptyOverlay(props: {
  visible: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <If when={props.visible()}>
      <View
        testID="mermaid-empty-state"
        style={{ pointerEvents: "none" }}
        class="absolute inset-0 items-center justify-center"
      >
        <Text style={{ color: props.theme().ui.mutedForeground }} class="text-xs font-mono">
          Empty diagram
        </Text>
      </View>
    </If>
  );
}

function PillIconButton(props: {
  testID: string;
  label: string;
  icon: "zoom-in" | "zoom-out";
  theme: Accessor<EditorTheme>;
  onPress: () => void;
}): JSX.Element {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{ backgroundColor: props.theme().ui.sidebar }}
      class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
    >
      <Icon name={props.icon} size={12} tint={() => props.theme().ui.foreground} />
    </Button>
  );
}

export function PillLabelButton(props: {
  testID: string;
  text: Accessor<string>;
  mono?: "mono";
  theme: Accessor<EditorTheme>;
  onPress: () => void;
}): JSX.Element {
  const textClass = props.mono ? "text-[11px] font-mono" : "text-[11px] font-medium";
  return (
    <Button
      testID={props.testID}
      onPress={props.onPress}
      style={{ backgroundColor: props.theme().ui.sidebar }}
      class="h-6 px-2 items-center justify-center rounded border-none shadow-none"
    >
      <Text style={{ color: props.theme().ui.foreground }} class={textClass}>
        {props.text()}
      </Text>
    </Button>
  );
}

/** Compact floating bottom-right zoom & copy pill for vector Mermaid diagrams. */
export function DiagramViewportPill(props: {
  kindLabel: Accessor<string>;
  zoom?: Accessor<number>;
  copied: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
  onZoomDelta: (delta: number) => void;
  onZoomReset: () => void;
  onCopy: () => void;
  trailing?: JSX.Element;
}): JSX.Element {
  return (
    <View
      style={{ backgroundColor: props.theme().ui.card }}
      class="absolute bottom-3 right-4 flex-row items-center gap-1.5 px-2.5 py-1 rounded-md shadow-lg select-none"
    >
      <Text style={{ color: props.theme().ui.mutedForeground }} class="text-[11px] font-mono pr-1">
        {props.kindLabel()}
      </Text>
      <If when={props.zoom?.()}>
        {(z) => (
          <View class="flex-row items-center gap-1">
            <PillIconButton
              testID="mermaid-zoom-out"
              label="Zoom out"
              icon="zoom-out"
              theme={props.theme}
              onPress={() => props.onZoomDelta(-25)}
            />
            <PillLabelButton
              testID="mermaid-zoom-reset"
              text={() => `${z()}%`}
              mono="mono"
              theme={props.theme}
              onPress={props.onZoomReset}
            />
            <PillIconButton
              testID="mermaid-zoom-in"
              label="Zoom in"
              icon="zoom-in"
              theme={props.theme}
              onPress={() => props.onZoomDelta(25)}
            />
          </View>
        )}
      </If>
      <PillLabelButton
        testID="mermaid-copy-code"
        text={() => (props.copied() ? "Copied" : "Copy")}
        theme={props.theme}
        onPress={props.onCopy}
      />
      {props.trailing}
    </View>
  );
}

function resolveCodeInput(code: string | Accessor<string>): string {
  return typeof code === "function" ? code() : code;
}

function resolveDiagramTheme(themeProp?: Accessor<EditorTheme>): EditorTheme {
  return themeProp?.() ?? (colorScheme() === "light" ? EDITOR_THEMES[0] : EDITOR_THEMES[1]);
}

interface DiagramBlockState {
  rawCode: Accessor<string>;
  activeTheme: Accessor<EditorTheme>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  themeCss: Accessor<string>;
  zoom: Signal<number>;
  errorMsg: Signal<string | null>;
  wvRef: WebViewRef | null;
  ready: boolean;
  renderSeq: number;
}

function sendBlockDiagram(state: DiagramBlockState): void {
  if (!state.wvRef || !state.ready) return;
  state.renderSeq += 1;
  state.errorMsg.set(null);
  const msg = formatDiagramRenderMessage({
    renderId: state.renderSeq,
    code: state.rawCode(),
    themeCss: state.themeCss(),
    theme: state.activeTheme(),
    fontFamily: state.fontStyle().fontFamily ?? "",
  });
  state.wvRef.injectJavaScript(
    CLEAR_PRELOAD_BG_JS +
      `window.__aed && window.__aed.renderDiagram(${JSON.stringify(msg)});` +
      formatDiagramZoomScript(state.zoom()),
  );
}

function applyBlockZoom(state: DiagramBlockState, next: number): void {
  const clamped = clampDiagramZoom(next);
  state.zoom.set(clamped);
  state.wvRef?.injectJavaScript(formatDiagramZoomScript(clamped));
}

function createBlockBridgeDeps(state: DiagramBlockState, onCopy: () => void): PreviewBridgeDeps {
  return {
    basePath: () => "",
    openUrl: () => undefined,
    openFile: () => undefined,
    readImageDataUrl: async () => null,
    inject: (js) => state.wvRef?.injectJavaScript(js),
    loadMermaidJs: loadMermaidBundleJs,
    rememberScroll: () => undefined,
    currentRenderId: () => state.renderSeq,
    mermaidConfig: () => buildMermaidConfig(state.activeTheme(), state.fontStyle().fontFamily ?? ""),
    onDiagramRendered: (res) => settleDiagramResult(state.errorMsg, state.wvRef, state.zoom(), res),
    onCopySource: onCopy,
  };
}

/** Vector WebView Mermaid diagram block (compat wrapper for `PreviewPane.tsx` until Wave 2B). */
export function MermaidDiagramBlock(props: {
  code: string | Accessor<string>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  theme?: Accessor<EditorTheme>;
}): JSX.Element {
  const rawCode = computed(() => resolveCodeInput(props.code));
  const activeTheme = computed(() => resolveDiagramTheme(props.theme));
  const kindLabel = computed(() => detectMermaidKind(rawCode()));
  const themeCss = computed(() => buildPreviewThemeCss(activeTheme(), props.fontStyle()));
  const showCode = signal(false);
  const showEmpty = computed(() => !showCode() && rawCode().trim().length === 0);
  const copyFeedback = createCopyFeedback(rawCode);
  const state: DiagramBlockState = {
    rawCode,
    activeTheme,
    fontStyle: props.fontStyle,
    themeCss,
    zoom: signal(100),
    errorMsg: signal<string | null>(null),
    wvRef: null,
    ready: false,
    renderSeq: 0,
  };

  effect(() => {
    void rawCode();
    void themeCss();
    sendBlockDiagram(state);
  });

  return (
    <View
      testID="mermaid-block"
      style={{ backgroundColor: activeTheme().ui.card }}
      class="w-full min-h-[420px] my-2 rounded-lg overflow-hidden relative"
    >
      <DiagramErrorBanner error={state.errorMsg} theme={activeTheme} />
      <If when={showCode()}>
        <View class="p-4 pb-12">
          <Text
            testID="mermaid-code-view"
            style={{ ...props.fontStyle(), color: activeTheme().ui.foreground }}
            class="select-text text-xs font-mono"
          >
            {rawCode().trim()}
          </Text>
        </View>
      </If>
      <View style={{ display: showCode() ? "none" : "flex", flex: 1, minHeight: 420 }}>
        <SandboxPreviewWebView
          theme={activeTheme}
          deps={createBlockBridgeDeps(state, copyFeedback.copy)}
          onRef={(r) => {
            state.wvRef = r;
          }}
          onReady={() => {
            state.ready = true;
            sendBlockDiagram(state);
          }}
        />
      </View>
      <DiagramEmptyOverlay visible={showEmpty} theme={activeTheme} />
      <DiagramViewportPill
        kindLabel={kindLabel}
        zoom={showCode() ? undefined : state.zoom}
        copied={copyFeedback.copied}
        theme={activeTheme}
        onZoomDelta={(d) => applyBlockZoom(state, state.zoom() + d)}
        onZoomReset={() => applyBlockZoom(state, 100)}
        onCopy={copyFeedback.copy}
        trailing={
          <PillLabelButton
            testID="mermaid-toggle-code"
            text={() => (showCode() ? "Diagram" : "Code")}
            theme={activeTheme}
            onPress={() => showCode.update((v) => !v)}
          />
        }
      />
    </View>
  );
}
