import {
  cleanup,
  computed,
  effect,
  Image,
  keymap,
  Scroll,
  signal,
  Text,
  Video,
  View,
  WebView,
  type Accessor,
  type JSX,
  type Signal,
} from "nsh";
import {
  Button,
  DataTable,
  DiffView,
  Editor,
  Input,
  TextView,
  type DataTableColumn,
  type DataTableSort,
  type DiffLayout,
  type EditorRef,
} from "nsh/base";
import type { PreviewMode } from "./classify";
import { Icon } from "./icons";
import { MermaidDiagramBlock, MermaidRendererHost } from "./mermaid";
import {
  buildEditorThemeStyles,
  computeSyntaxDecorations,
  EDITOR_THEMES,
  type EditorTheme,
} from "./themes";
import { type LoadedFile } from "./workspace";

const MARKDOWN_MERMAID_EXTENSIONS = [
  { name: "mermaid", language: "mermaid" },
  { name: "mermaid", language: "mmd" },
];

export interface PreviewPaneProps {
  file: Accessor<LoadedFile | undefined>;
  workspaceRoot: Accessor<string>;
  fontFamily?: Accessor<string>;
  fontSize?: Accessor<number>;
  theme?: Accessor<EditorTheme>;
  onTextChange: (filePath: string, newText: string) => void;
  onSave: (filePath: string) => void;
  onModeChange?: (filePath: string, mode: PreviewMode) => void;
  onOpenRelativeLink: (relUrl: string, baseFilePath: string) => void;
  onCursorChange?: (line: number, column: number) => void;
}

function compareCells(
  va: string | number | undefined,
  vb: string | number | undefined,
  sign: number
): number {
  if (va == null || vb == null) {
    if (va == null && vb == null) return 0;
    return (va == null ? -1 : 1) * sign;
  }
  if (typeof va === "number" && typeof vb === "number") {
    return (va - vb) * sign;
  }
  return String(va).localeCompare(String(vb)) * sign;
}

function sortRows(
  rows: (string | number)[][],
  columns: DataTableColumn[],
  sort: DataTableSort | null
): (string | number)[][] {
  if (!sort) return rows;
  const colIdx = columns.findIndex((c) => c.key === sort.key);
  if (colIdx < 0) return rows;
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => compareCells(a[colIdx], b[colIdx], sign));
}

function FindBar(props: {
  findOpen: Signal<boolean>;
  findQuery: Signal<string>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <If when={props.findOpen()}>
      <View
        style={{ backgroundColor: props.theme().ui.sidebar }}
        class="h-8 flex-row items-center px-3 gap-2 shrink-0"
      >
        <Input
          testID="editor-find-input"
          autoFocus
          value={props.findQuery()}
          onChange={({ value }) => props.findQuery.set(value)}
          placeholder="Find"
          style={{
            height: 24,
            backgroundColor: props.theme().ui.background,
            color: props.theme().ui.foreground,
          }}
          class="flex-1 h-6 px-2 text-xs text-foreground placeholder:text-muted-foreground rounded border-none"
        />
        <Button
          onPress={() => props.findOpen.set(false)}
          class="h-6 px-2 items-center justify-center rounded bg-transparent border-none shadow-none"
        >
          <Text
            style={{ color: props.theme().ui.mutedForeground }}
            class="text-xs"
          >
            Close
          </Text>
        </Button>
      </View>
    </If>
  );
}

function resolveDiffOldValue(file: LoadedFile): string | undefined {
  if (file.diffPatch) return undefined;
  if (file.gitStatus === "U" || file.gitStatus === "A") return "";
  return file.savedText;
}

function DiffBody(props: {
  file: Accessor<LoadedFile>;
  diffLayout: Signal<DiffLayout>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const f = props.file;
  const oldVal = computed(() => resolveDiffOldValue(f()));
  const newVal = computed(() => (f().diffPatch ? undefined : f().text));
  const statusText = computed(() => {
    if (f().diffPatch) return "Git diff vs HEAD";
    if (f().gitStatus === "U") return "Untracked file";
    if (f().gitStatus === "A") return "Staged new file";
    if (f().dirty) return "Unsaved changes";
    return "Working tree clean";
  });

  return (
    <View
      class="flex-1 relative"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <DiffView
        testID="preview-diff"
        patch={f().diffPatch || undefined}
        oldValue={oldVal()}
        newValue={newVal()}
        language={f().classification.language}
        layout={props.diffLayout()}
        softWrap
        fontFamily={props.fontStyle().fontFamily}
        fontSize={props.fontStyle().fontSize}
        lineHeight={Math.round(props.fontStyle().fontSize * 1.65)}
        styles={{
          gutter: { backgroundColor: props.theme().ui.gutter },
          lineNumber: { color: props.theme().ui.mutedForeground },
          content: {
            backgroundColor: props.theme().ui.background,
            color: props.theme().ui.foreground,
          },
        }}
        classes={{
          line: "whitespace-nowrap",
        }}
        style={{ backgroundColor: props.theme().ui.background }}
        class="flex-1"
      />
      <View
        style={{ backgroundColor: props.theme().ui.card }}
        class="absolute bottom-3 right-4 flex-row items-center gap-2 px-3 py-1 rounded-md shadow-lg select-none"
      >
        <Text
          style={{ color: props.theme().ui.mutedForeground }}
          class="text-[11px] font-mono"
        >
          {statusText()}
        </Text>
        <Button
          testID="diff-layout-toggle"
          onPress={() =>
            props.diffLayout.update((l) => (l === "split" ? "unified" : "split"))
          }
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="h-6 px-2 items-center justify-center rounded border-none shadow-none"
        >
          <Text
            style={{ color: props.theme().ui.foreground }}
            class="text-[11px] font-medium"
          >
            {props.diffLayout() === "split" ? "Unified View" : "Split View"}
          </Text>
        </Button>
      </View>
    </View>
  );
}

function bindEditorDecorationEffect(
  file: Accessor<LoadedFile>,
  theme: Accessor<EditorTheme>,
  decorations: Signal<ReturnType<typeof computeSyntaxDecorations>>
): void {
  let lastPath = file().path;
  let lastTheme = theme().id;
  let lastText = file().text;

  effect(() => {
    const curFile = file();
    const curTheme = theme();
    const text = curFile.text;
    const lang = curFile.classification.language;
    const isSameContext = curFile.path === lastPath && curTheme.id === lastTheme;
    if (isSameContext && text === lastText) return;
    if (!isSameContext) {
      lastPath = curFile.path;
      lastTheme = curTheme.id;
      lastText = text;
      decorations.set(computeSyntaxDecorations(text, lang, curTheme.syntaxClasses));
      return;
    }
    const timer = setTimeout(() => {
      lastText = text;
      decorations.set(computeSyntaxDecorations(text, lang, curTheme.syntaxClasses));
    }, 16);
    return () => clearTimeout(timer);
  });
}

function EditorBody(props: {
  file: Accessor<LoadedFile>;
  search: Accessor<{ query: string; caseSensitive: boolean } | undefined>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  theme: Accessor<EditorTheme>;
  onTextChange: (val: string) => void;
  onCursorChange?: (line: number, col: number) => void;
}): JSX.Element {
  const f = props.file;
  let editorRef: EditorRef | null = null;
  const editorStyles = computed(() => buildEditorThemeStyles(props.theme()));
  const decorations = signal(
    computeSyntaxDecorations(
      f().text,
      f().classification.language,
      props.theme().syntaxClasses
    )
  );
  bindEditorDecorationEffect(f, props.theme, decorations);

  effect(() => {
    void f().path;
    void f().mode;
    editorRef?.focus();
  });

  return (
    <Editor
      testID="preview-editor"
      ref={(r) => {
        editorRef = r;
        r?.focus();
      }}
      autoFocus
      value={f().text}
      language={f().classification.language}
      onChange={({ value }) => props.onTextChange(value)}
      onSelectionChange={({ selections }) => {
        const last = selections[selections.length - 1];
        if (last && props.onCursorChange) {
          props.onCursorChange(last.head.line, last.head.column);
        }
      }}
      search={props.search()}
      decorations={decorations()}
      styles={editorStyles()}
      lineNumbers
      softWrap
      highlighting
      autoClose
      autoIndent
      activeLine
      fontFamily={props.fontStyle().fontFamily}
      fontSize={props.fontStyle().fontSize}
      lineHeight={Math.round(props.fontStyle().fontSize * 1.65)}
      classes={{
        line: "whitespace-nowrap",
      }}
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1"
    />
  );
}

function TableBody(props: {
  file: Accessor<LoadedFile>;
  sort: Signal<DataTableSort | null>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const f = props.file;
  const sortedTableRows = computed(() =>
    sortRows(f().tableData?.rows ?? [], f().tableData?.columns ?? [], props.sort())
  );

  return (
    <DataTable
      testID="preview-table"
      columns={f().tableData?.columns ?? []}
      data={sortedTableRows()}
      rowCount={sortedTableRows().length}
      sort={props.sort()}
      onSortChange={({ sort }) => props.sort.set(sort)}
      stripe
      rowHeader
      classes={{
        headerCell: "text-foreground font-medium bg-muted/60 border-b border-r border-border px-3",
        cell: "text-foreground border-b border-r border-border/40 px-3",
        rowOdd: "bg-muted/15",
        rowHover: "bg-muted/30",
        rowHeader: "text-muted-foreground bg-muted/40 border-b border-r border-border px-2",
        rowHeaderCorner: "bg-muted/60 border-b border-r border-border",
      }}
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1"
    />
  );
}

function QuickLookBody(props: {
  file: Accessor<LoadedFile>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const f = props.file;
  const zoom = signal<number>(100);
  const sheetWidth = computed(() => Math.round(580 * (zoom() / 100)));
  const sheetHeight = computed(() => Math.round(750 * (zoom() / 100)));

  return (
    <View
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1 relative"
    >
      <If when={f().quickLookUrl}>
        {(url) => (
          <View class="flex-1">
            <Scroll class="flex-1">
              <View class="flex-1 min-h-full items-center justify-center p-6">
                <View
                  testID="preview-quicklook-sheet"
                  style={{
                    backgroundColor: "#f7f4ee",
                    width: sheetWidth(),
                    height: sheetHeight(),
                  }}
                  class="rounded shadow-2xl items-center justify-center overflow-hidden"
                >
                  <Image
                    testID="preview-quicklook"
                    src={url()}
                    style={{
                      width: sheetWidth(),
                      height: sheetHeight(),
                      objectFit: "contain",
                    }}
                  />
                </View>
              </View>
            </Scroll>
            <View
              style={{ backgroundColor: props.theme().ui.card }}
              class="absolute bottom-3 left-3 h-7 px-2 rounded shadow-xl flex-row items-center gap-1"
            >
              <Button
                testID="quicklook-zoom-out"
                onPress={() => zoom.update((z) => Math.max(50, z - 25))}
                class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
              >
                <Icon
                  name="zoom-out"
                  size={12}
                  tint={() => props.theme().ui.foreground}
                />
              </Button>
              <Button
                testID="quicklook-zoom-reset"
                onPress={() => zoom.set(100)}
                class="h-6 px-2 rounded bg-transparent border-none shadow-none"
              >
                <Text
                  style={{ color: props.theme().ui.foreground }}
                  class="text-xs font-mono"
                >
                  {`${zoom()}%`}
                </Text>
              </Button>
              <Button
                testID="quicklook-zoom-in"
                onPress={() => zoom.update((z) => Math.min(300, z + 25))}
                class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
              >
                <Icon
                  name="zoom-in"
                  size={12}
                  tint={() => props.theme().ui.foreground}
                />
              </Button>
            </View>
          </View>
        )}
      </If>
      <If when={!f().quickLookUrl}>
        <View class="flex-1 items-center justify-center p-6 gap-2">
          <Text
            style={{ color: props.theme().ui.mutedForeground }}
            class="text-xs"
          >
            Preview unavailable
          </Text>
        </View>
      </If>
    </View>
  );
}

function getActiveView(file: LoadedFile): string {
  if (file.mode === "diff") return "diff";
  if (file.mode === "source" || file.classification.kind === "code") return "editor";
  return file.classification.kind;
}

export function formatMediaMeta(file: LoadedFile): string {
  const dim = file.dimensions;
  const dimText = dim ? `${dim.width} × ${dim.height} · ` : "";
  return `${dimText}${file.classification.mimeType}`;
}

function ImageBody(props: {
  file: Accessor<LoadedFile>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const zoom = signal(100);
  const lightBg = signal(false);
  const metaText = computed(() => formatMediaMeta(props.file()));
  const clampZoom = (next: number) => Math.max(25, Math.min(400, next));

  return (
    <View
      testID="preview-image-container"
      style={{
        backgroundColor: lightBg() ? "#e5e5e5" : props.theme().ui.background,
      }}
      class="flex-1 relative items-center justify-center p-6"
    >
      <If when={props.file().blobUrl}>
        {(url) => (
          <View
            class="items-center justify-center"
            style={{
              width: `${zoom()}%`,
              height: `${zoom()}%`,
            }}
          >
            <Image
              testID="preview-image"
              src={url()}
              class="w-full h-full"
              style={{ objectFit: "contain" }}
            />
          </View>
        )}
      </If>
      <View
        style={{ backgroundColor: props.theme().ui.card }}
        class="absolute bottom-4 self-center flex-row items-center gap-2 px-3 py-1 rounded-md shadow-lg select-none"
      >
        <Text
          style={{ color: props.theme().ui.mutedForeground }}
          class="text-[11px] font-mono pr-1"
        >
          {metaText()}
        </Text>
        <Button
          testID="image-zoom-out"
          onPress={() => zoom.update((z) => clampZoom(z - 25))}
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
        >
          <Icon
            name="zoom-out"
            size={12}
            tint={() => props.theme().ui.foreground}
          />
        </Button>
        <Button
          testID="image-zoom-reset"
          onPress={() => zoom.set(100)}
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="h-6 px-2 items-center justify-center rounded border-none shadow-none"
        >
          <Text
            style={{ color: props.theme().ui.foreground }}
            class="text-[11px] font-mono"
          >
            {`${zoom()}%`}
          </Text>
        </Button>
        <Button
          testID="image-zoom-in"
          onPress={() => zoom.update((z) => clampZoom(z + 25))}
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
        >
          <Icon
            name="zoom-in"
            size={12}
            tint={() => props.theme().ui.foreground}
          />
        </Button>
        <Button
          testID="image-bg-toggle"
          onPress={() => lightBg.update((v) => !v)}
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="h-6 px-2 items-center justify-center rounded border-none shadow-none"
        >
          <Text
            style={{ color: props.theme().ui.foreground }}
            class="text-[11px] font-medium"
          >
            {lightBg() ? "Dark BG" : "Light BG"}
          </Text>
        </Button>
      </View>
    </View>
  );
}

function VideoBody(props: {
  file: Accessor<LoadedFile>;
}): JSX.Element {
  return (
    <View
      testID="preview-video-container"
      class="flex-1 relative items-center justify-center p-4 bg-black/90"
    >
      <Video
        testID="preview-video"
        src={props.file().path}
        controls
        class="w-full h-full flex-1"
      />
    </View>
  );
}

function AudioBody(props: {
  file: Accessor<LoadedFile>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const metaText = computed(() => props.file().classification.mimeType);
  return (
    <View
      testID="preview-audio-container"
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1 relative items-center justify-center p-8"
    >
      <View
        style={{ backgroundColor: props.theme().ui.card }}
        class="w-[520px] max-w-full p-6 rounded-xl items-center gap-4"
      >
        <View
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="w-12 h-12 rounded-lg items-center justify-center"
        >
          <Icon
            name="music"
            size={20}
            tint={() => props.theme().ui.accent}
          />
        </View>
        <View class="items-center gap-1">
          <Text
            style={{ color: props.theme().ui.foreground }}
            class="text-sm font-medium"
          >
            {props.file().name}
          </Text>
          <Text
            style={{ color: props.theme().ui.mutedForeground }}
            class="text-xs font-mono"
          >
            {metaText()}
          </Text>
        </View>
        <View
          style={{ backgroundColor: props.theme().ui.sidebar }}
          class="w-full h-28 rounded-lg overflow-hidden"
        >
          <Video
            testID="preview-audio"
            src={props.file().path}
            controls
            class="w-full h-28"
          />
        </View>
      </View>
    </View>
  );
}

function PreviewBody(props: {
  file: Accessor<LoadedFile>;
  root: Accessor<string>;
  diffLayout: Signal<DiffLayout>;
  tableSort: Signal<DataTableSort | null>;
  search: Accessor<{ query: string; caseSensitive: boolean } | undefined>;
  theme: Accessor<EditorTheme>;
  paneProps: PreviewPaneProps;
}): JSX.Element {
  const activeView = computed(() => getActiveView(props.file()));
  const fontStyle = computed(() => ({
    fontFamily: props.paneProps.fontFamily?.() || undefined,
    fontSize: props.paneProps.fontSize?.() ?? 13,
  }));

  return (
    <View
      class="flex-1"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <If when={activeView() === "diff"}>
        <DiffBody
          file={props.file}
          diffLayout={props.diffLayout}
          fontStyle={fontStyle}
          theme={props.theme}
        />
      </If>
      <If when={activeView() === "quicklook"}>
        <QuickLookBody file={props.file} theme={props.theme} />
      </If>
      <If when={activeView() === "table"}>
        <TableBody
          file={props.file}
          sort={props.tableSort}
          theme={props.theme}
        />
      </If>
      <If when={activeView() === "binary"}>
        <Editor
          testID="preview-hex"
          value={props.file().hexDump}
          readOnly
          language="plaintext"
          lineNumbers={false}
          fontFamily={fontStyle().fontFamily}
          fontSize={fontStyle().fontSize}
          lineHeight={Math.round(fontStyle().fontSize * 1.65)}
          styles={buildEditorThemeStyles(props.theme())}
          classes={{ line: "whitespace-nowrap" }}
          style={{ backgroundColor: props.theme().ui.background }}
          class="flex-1"
        />
      </If>
      <If when={activeView() === "markdown"}>
        <Scroll
          class="flex-1 p-6"
          style={{ backgroundColor: props.theme().ui.background }}
        >
          <TextView
            testID="preview-markdown"
            markdown={props.file().text}
            selectable
            codeBlockActions={[{ id: "copy" }]}
            extensions={MARKDOWN_MERMAID_EXTENSIONS}
            renderCustom={(node) => (
              <MermaidDiagramBlock
                code={node.text ?? ""}
                fontStyle={fontStyle}
                theme={props.theme}
              />
            )}
            styles={{ codeBlockCode: fontStyle(), code: fontStyle() }}
            onLinkPress={({ url }) =>
              props.paneProps.onOpenRelativeLink(url, props.file().path)
            }
          />
        </Scroll>
      </If>
      <If when={activeView() === "mermaid"}>
        <Scroll
          testID="preview-mermaid"
          class="flex-1 p-6"
          style={{ backgroundColor: props.theme().ui.background }}
        >
          <MermaidDiagramBlock
            code={() => props.file().text}
            fontStyle={fontStyle}
            theme={props.theme}
          />
        </Scroll>
      </If>
      <If when={activeView() === "html"}>
        <WebView testID="preview-webview" html={props.file().text} class="flex-1" />
      </If>
      <If when={activeView() === "image"}>
        <ImageBody file={props.file} theme={props.theme} />
      </If>
      <If when={activeView() === "video"}>
        <VideoBody file={props.file} />
      </If>
      <If when={activeView() === "audio"}>
        <AudioBody file={props.file} theme={props.theme} />
      </If>
      <If when={activeView() === "editor"}>
        <EditorBody
          file={props.file}
          search={props.search}
          fontStyle={fontStyle}
          theme={props.theme}
          onTextChange={(val) => props.paneProps.onTextChange(props.file().path, val)}
          onCursorChange={props.paneProps.onCursorChange}
        />
      </If>
    </View>
  );
}

export function PreviewPane(props: PreviewPaneProps): JSX.Element {
  const findOpen = signal(false);
  const findQuery = signal("");
  const diffLayout = signal<DiffLayout>("split");
  const tableSort = signal<DataTableSort | null>(null);
  const activeTheme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);

  cleanup(
    keymap.bind({
      "mod+f": () => {
        const cur = props.file();
        if (cur && getActiveView(cur) === "editor") {
          findOpen.update((v) => !v);
        }
      },
    })
  );

  const searchParam = computed(() =>
    findOpen() && findQuery()
      ? { query: findQuery(), caseSensitive: false }
      : undefined
  );

  return (
    <View
      class="flex-1"
      style={{ backgroundColor: activeTheme().ui.background }}
    >
      <View class="hidden text-rose-400 text-emerald-300 text-fuchsia-300 text-stone-500 text-teal-300 text-amber-200 text-sky-300 text-orange-300 text-amber-300 text-purple-400 text-lime-300 text-orange-400 text-slate-500 text-cyan-300 text-blue-400 text-amber-400 text-violet-300 text-green-300 text-zinc-500 text-yellow-200 text-blue-300 text-pink-300 text-pink-400 text-emerald-400 text-red-400 text-yellow-300 text-sky-400 text-cyan-400 text-rose-300 text-teal-200 text-purple-300 text-indigo-300 text-red-600 text-blue-900 text-blue-600 text-emerald-700 text-amber-700 text-purple-700 text-blue-700 italic font-semibold" />
      <MermaidRendererHost />
      <If when={props.file()}>
        {(currentFile) => (
          <View class="flex-1">
            <FindBar
              findOpen={findOpen}
              findQuery={findQuery}
              theme={activeTheme}
            />
            <PreviewBody
              file={currentFile}
              root={props.workspaceRoot}
              diffLayout={diffLayout}
              tableSort={tableSort}
              search={searchParam}
              theme={activeTheme}
              paneProps={props}
            />
          </View>
        )}
      </If>
    </View>
  );
}
