import * as fs from "fs/promises";
import { Buffer } from "buffer";
import {
  computed,
  effect,
  host,
  openUrl,
  signal,
  WebView,
  type Accessor,
  type JSX,
  type WebViewRef,
} from "nsh";
import {
  buildPreviewShellHtml,
  buildPreviewThemeCss,
  handlePreviewMessage,
  imageMimeForPath,
  parsePreviewMessage,
  type PreviewBridgeDeps,
} from "./markdownPage";
import { buildMermaidConfig, loadMermaidBundleJs } from "./mermaid";
import { MARKDOWN_RUNTIME_JS } from "./markdownVendor.generated";
import type { EditorTheme } from "./themes";
import type { LoadedFile } from "./workspace";

const IMAGE_BYTES_CAP = 20 * 1024 * 1024;
const RENDER_DEBOUNCE_MS = 120;

/** Per-path scroll memory for the shared preview page (in-memory only). */
const scrollMemory = new Map<string, number>();

/** Built once: the `html` prop must stay the same value or the view reloads. */
const SHELL_HTML = buildPreviewShellHtml();

async function readImageDataUrl(p: string): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile() || stat.size > IMAGE_BYTES_CAP) return null;
    const mime = imageMimeForPath(p);
    if (!mime) return null;
    const bytes = await fs.readFile(p);
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

export function MarkdownPreview(props: {
  file: Accessor<LoadedFile>;
  theme: Accessor<EditorTheme>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  /** Receives an already-resolved absolute path. */
  onOpenRelativeLink: (resolvedPath: string) => void;
}): JSX.Element {
  const wv = signal<WebViewRef | null>(null);
  const pageReady = signal(false);
  let renderSeq = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPath = "";

  const themeCss = computed(() =>
    buildPreviewThemeCss(props.theme(), props.fontStyle()),
  );
  const mermaidConfig = () => ({
    // Preview diagrams use the body UI font, not the editor mono font.
    ...buildMermaidConfig(props.theme(), ""),
    securityLevel: "strict",
  });

  const deps: PreviewBridgeDeps = {
    basePath: () => props.file().path,
    openUrl: (url) => {
      void openUrl(url);
    },
    openFile: (p) => props.onOpenRelativeLink(p),
    readImageDataUrl,
    inject: (js) => wv()?.injectJavaScript(js),
    loadMermaidJs: loadMermaidBundleJs,
    rememberScroll: (p, y) => scrollMemory.set(p, y),
    currentRenderId: () => renderSeq,
    mermaidConfig,
  };

  function sendRender() {
    const w = wv();
    if (!w || !pageReady()) return;
    const f = props.file();
    // `file` can be undefined while a new file loads — skip, the next
    // change fires another render.
    if (!f || f.classification.kind !== "markdown" || f.mode !== "preview") {
      return;
    }
    renderSeq += 1;
    const payload = {
      renderId: renderSeq,
      path: f.path,
      markdown: f.text,
      themeCss: themeCss(),
      scrollY: scrollMemory.get(f.path) ?? 0,
      mermaidConfig: mermaidConfig(),
    };
    w.injectJavaScript(
      `window.__aed && window.__aed.render(${JSON.stringify(payload)});`,
    );
  }

  function sendTheme() {
    const w = wv();
    if (!w || !pageReady()) return;
    w.injectJavaScript(
      `window.__aed.setTheme(${JSON.stringify({
        themeCss: themeCss(),
        mermaidConfig: mermaidConfig(),
      })});`,
    );
  }

  // Path changes re-render immediately; same-path edits debounce 120 ms.
  effect(() => {
    const f = props.file();
    if (!f) return;
    const p = f.path;
    void f.text;
    if (p !== lastPath) {
      lastPath = p;
      if (renderTimer) clearTimeout(renderTimer);
      sendRender();
    } else {
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(sendRender, RENDER_DEBOUNCE_MS);
    }
  });

  // Theme or font changes recolor without a markdown re-parse.
  effect(() => {
    void themeCss();
    sendTheme();
  });

  // Debug channel used by real-window tests: the embedding host can inject
  // arbitrary page JS (`aed.preview.eval`), and a page message prefixed
  // `__dbg:` is echoed back to it (`aedPreviewDebug` posts). The packaged
  // app's own host never sends these.
  host.on("aed.preview.eval", (d) => {
    const js = (d as { js?: unknown } | null)?.js;
    if (typeof js === "string") wv()?.injectJavaScript(js);
  });

  return (
    <WebView
      ref={(r) => wv.set(r)}
      testID="preview-markdown"
      html={SHELL_HTML}
      class="flex-1"
      onLoad={() => {
        const w = wv();
        if (!w) return;
        pageReady.set(true);
        // Runtime first (once per page load; the page's install guard makes
        // a duplicate inject harmless), then the current render payload.
        w.injectJavaScript(MARKDOWN_RUNTIME_JS);
        sendRender();
      }}
      onMessage={({ data }) => {
        if (data.startsWith("__dbg:")) {
          host.post("aedPreviewDebug", data.slice(6));
          return;
        }
        const msg = parsePreviewMessage(data);
        if (msg) void handlePreviewMessage(msg, deps);
      }}
    />
  );
}
