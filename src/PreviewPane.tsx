import {
  cleanup,
  computed,
  effect,
  Image,
  keymap,
  Scroll,
  signal,
  Text,
  untracked,
  Video,
  View,
  WebView,
  type Accessor,
  type JSX,
  type Signal,
} from "nsh";
import {
  DataTable,
  DiffView,
  Editor,
  Input,
  type DataTableColumn,
  type DataTableSort,
  type DataTableStyles,
  type DiffLayout,
  type EditorCommand,
  type EditorRef,
  type EditorSearchResult,
} from "nsh/base";
import type { PreviewMode } from "./classify";
import { Icon } from "./icons";
import { MarkdownPreview } from "./MarkdownPreview";
import type { TabEntry } from "./tabs";
import {
  buildEditorThemeStyles,
  computeSyntaxDecorations,
  EDITOR_THEMES,
  type EditorTheme,
} from "./themes";
import { createZoom, IconButton, SurfaceButton, ViewportPill } from "./ui";
import { type FileLocation, type LoadedFile } from "./workspace";

export interface PreviewPaneProps {
  file: Accessor<LoadedFile | undefined>;
  tab?: Accessor<TabEntry | undefined>;
  workspaceRoot: Accessor<string>;
  fontFamily?: Accessor<string>;
  fontSize?: Accessor<number>;
  theme?: Accessor<EditorTheme>;
  onTextChange: (filePath: string, newText: string) => void;
  onSave: (filePath: string) => void;
  onModeChange?: (filePath: string, mode: PreviewMode) => void;
  /** Receives an already-resolved absolute path (and optional 1-based location). */
  onOpenRelativeLink: (
    resolvedPath: string,
    loc?: { line?: number; column?: number },
  ) => void;
  onCursorChange?: (line: number, column: number) => void;
  /** A place to move the caret to once this file is in the editor. */
  reveal?: Accessor<FileLocation | null>;
  onRevealed?: () => void;
}

const CELL_COLLATOR =
  typeof Intl !== "undefined" && typeof Intl.Collator === "function"
    ? new Intl.Collator()
    : null;

/** Empty cells first, then numbers, then text: one order however a mixed column starts. */
function cellRank(value: string | number | undefined): number {
  if (value == null) return 0;
  return typeof value === "number" ? 1 : 2;
}

function compareText(a: string, b: string): number {
  return CELL_COLLATOR ? CELL_COLLATOR.compare(a, b) : a.localeCompare(b);
}

/** Ascending order of two cells. */
function compareCells(va: string | number | undefined, vb: string | number | undefined): number {
  const rank = cellRank(va) - cellRank(vb);
  if (rank !== 0 || va == null) return rank;
  if (typeof va === "number") return va - (vb as number);
  return compareText(String(va), String(vb));
}

export function sortRows(
  rows: (string | number)[][],
  columns: DataTableColumn[],
  sort: DataTableSort | null,
): (string | number)[][] {
  if (!sort) return rows;
  const colIdx = columns.findIndex((c) => c.key === sort.key);
  if (colIdx < 0) return rows;
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => compareCells(a[colIdx], b[colIdx]) * sign);
}

/** Format `EditorSearchResult` as `current+1/count` (`0/0` when no query or zero matches). */
export function formatSearchCount(
  result: EditorSearchResult | null,
  hasQuery: boolean,
): string {
  if (!hasQuery || !result || result.count <= 0) return "0/0";
  return `${(result.current ?? 0) + 1}/${result.count}`;
}

/** The editor's find bar while it shows; Escape closes it. */
function FindBar(props: {
  findOpen: Signal<boolean>;
  findQuery: Signal<string>;
  searchResult: Accessor<EditorSearchResult | null>;
  theme: Accessor<EditorTheme>;
  onRunEditorCmd: (cmd: EditorCommand) => void;
}): JSX.Element {
  cleanup(keymap.bind("escape", () => props.findOpen.set(false), { when: "always" }));
  const matchLabel = computed(() =>
    formatSearchCount(props.searchResult(), props.findQuery().length > 0),
  );
  const hasMatches = computed(
    () => props.findQuery().length > 0 && (props.searchResult()?.count ?? 0) > 0,
  );
  return (
    <View
      style={{
        backgroundColor: props.theme().ui.sidebar,
        borderBottomWidth: 1,
        borderBottomColor: props.theme().ui.border,
      }}
      class="h-8 flex-row items-center px-3 gap-1.5 shrink-0 select-none border-b border-border"
    >
      <Input
        testID="editor-find-input"
        autoFocus
        value={props.findQuery()}
        onChange={({ value }) => props.findQuery.set(value)}
        onSubmit={() => props.onRunEditorCmd("findNext")}
        placeholder="Find"
        style={{
          height: 24,
          backgroundColor: props.theme().ui.background,
          color: props.theme().ui.foreground,
          borderWidth: 1,
          borderColor: props.theme().ui.border,
        }}
        class="flex-1 h-6 px-2 text-xs text-foreground placeholder:text-muted-foreground rounded border border-border"
      />
      <Text
        testID="find-match-count"
        style={{ color: props.theme().ui.mutedForeground }}
        class="text-[11px] font-mono tabular-nums px-1 shrink-0"
      >
        {matchLabel()}
      </Text>
      <IconButton
        icon="chevron-down"
        iconSize={12}
        accessibilityLabel="Previous match"
        testID="find-prev-btn"
        disabled={!hasMatches()}
        onPress={() => props.onRunEditorCmd("findPrevious")}
        class="rotate-180"
      />
      <IconButton
        icon="chevron-down"
        iconSize={12}
        accessibilityLabel="Next match"
        testID="find-next-btn"
        disabled={!hasMatches()}
        onPress={() => props.onRunEditorCmd("findNext")}
      />
      <IconButton
        icon="close"
        iconSize={12}
        accessibilityLabel="Close find"
        testID="find-close-btn"
        onPress={() => props.findOpen.set(false)}
      />
    </View>
  );
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseNewHunkStart(line: string): number | null {
  const m = HUNK_HEADER_RE.exec(line);
  return m ? Math.max(1, Number(m[1])) : null;
}

function stepReverseHunkLine(
  prefix: string,
  rest: string,
  oldLines: string[],
  cursor: number,
): number {
  if (prefix === " ") {
    oldLines.push(rest);
    return cursor + 1;
  }
  if (prefix === "-") {
    oldLines.push(rest);
    return cursor;
  }
  return prefix === "+" ? cursor + 1 : cursor;
}

function collectReversedLines(newLines: readonly string[], patch: string): string[] | null {
  const oldLines: string[] = [];
  let cursor = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const start = parseNewHunkStart(raw);
    if (start !== null) {
      const targetIdx = Math.min(newLines.length, start - 1);
      while (cursor < targetIdx) oldLines.push(newLines[cursor++]);
      inHunk = true;
    } else if (inHunk && raw.length > 0) {
      cursor = stepReverseHunkLine(raw[0], raw.slice(1), oldLines, cursor);
    }
  }
  if (!inHunk) return null;
  while (cursor < newLines.length) oldLines.push(newLines[cursor++]);
  return oldLines;
}

/** Reconstruct `HEAD` base text by reversing a single-file unified `patch` against `savedText`. */
export function reconstructBaseFromPatch(savedText: string, patch: string): string {
  if (!patch) return savedText;
  const hasTrailingNl = savedText.endsWith("\n");
  const body = hasTrailingNl ? savedText.slice(0, -1) : savedText;
  const newLines = body.length > 0 ? body.split("\n") : [];
  const oldLines = collectReversedLines(newLines, patch);
  if (!oldLines) return savedText;
  const joined = oldLines.join("\n");
  return hasTrailingNl && joined.length > 0 ? `${joined}\n` : joined;
}

interface DiffInputs {
  patch: string | undefined;
  oldValue: string | undefined;
  newValue: string | undefined;
  status: string;
}

function resolveDirtyDiffInputs(file: LoadedFile): DiffInputs {
  if (file.gitStatus === "U" || file.gitStatus === "A") {
    return { patch: undefined, oldValue: "", newValue: file.text, status: "Unsaved changes" };
  }
  const base = file.diffPatch
    ? reconstructBaseFromPatch(file.savedText, file.diffPatch)
    : file.savedText;
  const status = file.diffPatch ? "Git diff vs HEAD (unsaved)" : "Unsaved changes";
  return { patch: undefined, oldValue: base, newValue: file.text, status };
}

export function resolveDiffInputs(file: LoadedFile): DiffInputs {
  if (file.classification.kind === "diff") {
    return { patch: file.text, oldValue: undefined, newValue: undefined, status: "Patch preview" };
  }
  if (file.dirty) return resolveDirtyDiffInputs(file);
  if (file.diffPatch) {
    return { patch: file.diffPatch, oldValue: undefined, newValue: undefined, status: "Git diff vs HEAD" };
  }
  if (file.gitStatus === "U") {
    return { patch: undefined, oldValue: "", newValue: file.text, status: "Untracked file" };
  }
  if (file.gitStatus === "A") {
    return { patch: undefined, oldValue: "", newValue: file.text, status: "Staged new file" };
  }
  return { patch: undefined, oldValue: file.savedText, newValue: file.text, status: "Working tree clean" };
}

function DiffBody(props: {
  file: Accessor<LoadedFile>;
  diffLayout: Signal<DiffLayout>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const inputs = computed(() => resolveDiffInputs(props.file()));
  const toggleLabel = computed(() =>
    props.diffLayout() === "split" ? "Unified View" : "Split View",
  );

  return (
    <View class="flex-1 relative" style={{ backgroundColor: props.theme().ui.background }}>
      <DiffView
        testID="preview-diff"
        patch={inputs().patch}
        oldValue={inputs().oldValue}
        newValue={inputs().newValue}
        language={props.file().classification.language}
        layout={props.diffLayout()}
        softWrap
        fontFamily={props.fontStyle().fontFamily}
        fontSize={props.fontStyle().fontSize}
        lineHeight={Math.round(props.fontStyle().fontSize * 1.54)}
        styles={{
          gutter: { backgroundColor: props.theme().ui.background },
          lineNumber: {
            color: `${props.theme().ui.mutedForeground.slice(0, 7)}99`,
            fontVariant: ["tabular-nums"],
          },
          content: {
            backgroundColor: props.theme().ui.background,
            color: props.theme().ui.foreground,
          },
        }}
        classes={{ line: "whitespace-nowrap" }}
        style={{ backgroundColor: props.theme().ui.background }}
        class="flex-1"
      />
      <ViewportPill meta={inputs().status}>
        <SurfaceButton
          size="sm"
          testID="diff-layout-toggle"
          label={toggleLabel()}
          onPress={() => props.diffLayout.update((l) => (l === "split" ? "unified" : "split"))}
        />
      </ViewportPill>
    </View>
  );
}

function bindEditorDecorationEffect(
  file: Accessor<LoadedFile>,
  theme: Accessor<EditorTheme>,
  decorations: Signal<ReturnType<typeof computeSyntaxDecorations>>,
): void {
  let lastTheme = untracked(() => theme().id);
  let lastText = untracked(() => file().text);

  effect(() => {
    const curFile = file();
    const curTheme = theme();
    const text = curFile.text;
    const lang = curFile.classification.language;
    const cacheKey = `${curFile.path}\0${curTheme.id}`;
    if (curTheme.id !== lastTheme) {
      lastTheme = curTheme.id;
      lastText = text;
      // Flush `[]` for one frame first: `nsh-base` 0.4.0 `RowContent` compares decoration
      // index vectors (`Vec<usize>`), so replacing same-range decorations in one step
      // would keep `old == new` and leave stale theme colors on visible spans.
      decorations.set([]);
      const flushTimer = setTimeout(() => {
        decorations.set(computeSyntaxDecorations(text, lang, curTheme, cacheKey));
      }, 0);
      return () => clearTimeout(flushTimer);
    }
    if (text === lastText) return;
    const timer = setTimeout(() => {
      lastText = text;
      decorations.set(computeSyntaxDecorations(text, lang, curTheme, cacheKey));
    }, 16);
    return () => clearTimeout(timer);
  });
}

/**
 * Scan `\n` up to `targetLine` (1-based) without `text.split("\n")` allocations,
 * clamping past the last line or past the line's length.
 */
export function clampRevealPosition(
  text: string,
  targetLine: number,
  targetCol: number,
): { line: number; column: number } {
  const wantLine = Math.max(0, targetLine - 1);
  let lineIdx = 0;
  let lineStart = 0;
  while (lineIdx < wantLine) {
    const nl = text.indexOf("\n", lineStart);
    if (nl < 0) break;
    lineStart = nl + 1;
    lineIdx += 1;
  }
  const lineEndNl = text.indexOf("\n", lineStart);
  let lineLen = (lineEndNl < 0 ? text.length : lineEndNl) - lineStart;
  if (lineLen > 0 && text.charCodeAt(lineStart + lineLen - 1) === 13) lineLen -= 1;
  return {
    line: lineIdx,
    column: Math.min(Math.max(0, targetCol - 1), lineLen),
  };
}

function revealInEditor(
  editor: EditorRef | null,
  file: LoadedFile,
  target: FileLocation | null | undefined,
): boolean {
  if (!editor || !target || target.path !== file.path) return false;
  const at = clampRevealPosition(file.text, target.line, target.column);
  editor.setSelections([{ anchor: at, head: at }]);
  editor.revealPosition(at, true);
  return true;
}

function bindEditorFocusEffects(
  file: Accessor<LoadedFile>,
  findShown: Accessor<boolean>,
  getRef: () => EditorRef | null,
): void {
  const focusKey = computed(() => `${file().path}\0${file().mode}`);
  effect(() => {
    void focusKey();
    getRef()?.focus();
  });
  let wasFindShown = untracked(findShown);
  effect(() => {
    const shown = findShown();
    if (wasFindShown && !shown) getRef()?.focus();
    wasFindShown = shown;
  });
}

export interface EditorLayoutConfig {
  softWrap: boolean;
  lineHeight: number;
  scrollBeyondLastLine: number;
  classes: { line: string } | undefined;
}

/**
 * Prose & Markdown source wrap softly at window edge with airy 1.68x leading;
 * structured code stays unwrapped at crisp 1.54x leading with horizontal scroll.
 */
export function resolveEditorLayout(
  classification: { kind: string; language: string },
  fontSize: number,
): EditorLayoutConfig {
  const wrapProse =
    classification.kind === "markdown" || classification.language === "plaintext";
  return {
    softWrap: wrapProse,
    lineHeight: Math.round(fontSize * (wrapProse ? 1.68 : 1.54)),
    scrollBeyondLastLine: 8,
    classes: wrapProse ? undefined : { line: "whitespace-nowrap" },
  };
}

function EditorBody(props: {
  file: Accessor<LoadedFile>;
  search: Accessor<{ query: string; caseSensitive: boolean } | undefined>;
  findShown: Accessor<boolean>;
  fontStyle: Accessor<{ fontFamily?: string; fontSize: number }>;
  theme: Accessor<EditorTheme>;
  onTextChange: (val: string) => void;
  onCursorChange?: (line: number, col: number) => void;
  onSearchResult: (res: EditorSearchResult) => void;
  onEditorRef: (ref: EditorRef, mounted: boolean) => void;
  reveal?: Accessor<FileLocation | null>;
  onRevealed?: () => void;
  onFocusChange: (focused: boolean) => void;
}): JSX.Element {
  const f = props.file;
  const initialSnapshot = untracked(f);
  const initialTheme = untracked(props.theme);
  let editorRef: EditorRef | null = null;

  cleanup(() => {
    if (editorRef) props.onEditorRef(editorRef, false);
  });

  const applyReveal = () => {
    if (revealInEditor(editorRef, f(), props.reveal?.())) props.onRevealed?.();
  };
  effect(applyReveal);

  const editorStyles = computed(() => buildEditorThemeStyles(props.theme()));
  const layout = computed(() =>
    resolveEditorLayout(f().classification, props.fontStyle().fontSize),
  );
  const decorations = signal(
    computeSyntaxDecorations(
      initialSnapshot.text,
      initialSnapshot.classification.language,
      initialTheme,
      `${initialSnapshot.path}\0${initialTheme.id}`,
    ),
  );
  bindEditorDecorationEffect(f, props.theme, decorations);
  bindEditorFocusEffects(f, props.findShown, () => editorRef);

  return (
    <Editor
      testID="preview-editor"
      ref={(r) => {
        editorRef = r;
        if (r) props.onEditorRef(r, true);
        r?.focus();
        applyReveal();
      }}
      autoFocus
      readOnly={f().readOnly !== null}
      defaultValue={initialSnapshot.text}
      language={f().classification.language}
      onChange={({ value }) => props.onTextChange(value)}
      onFocus={() => props.onFocusChange(true)}
      onBlur={() => props.onFocusChange(false)}
      onSearchChange={({ result }) => props.onSearchResult(result)}
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
      softWrap={layout().softWrap}
      scrollBeyondLastLine={layout().scrollBeyondLastLine}
      highlighting
      autoClose
      autoIndent
      activeLine
      fontFamily={props.fontStyle().fontFamily}
      fontSize={props.fontStyle().fontSize}
      lineHeight={layout().lineHeight}
      classes={layout().classes}
      style={{ backgroundColor: props.theme().ui.background }}
      class="flex-1"
    />
  );
}

const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'";

export function withPreviewCsp(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  return doctype + meta + html.slice(doctype.length);
}

function invalidLinesNotice(lines: readonly number[]): string | null {
  if (lines.length === 0) return null;
  const listed = lines.slice(0, 8).join(", ") + (lines.length > 8 ? ", …" : "");
  const noun = lines.length === 1 ? "line" : "lines";
  return `Skipped ${lines.length} ${noun} that ${lines.length === 1 ? "is" : "are"} not a JSON object: ${listed}`;
}

function buildTableStyles(theme: EditorTheme): DataTableStyles {
  const ui = theme.ui;
  return {
    root: { backgroundColor: ui.background, borderColor: ui.border },
    header: { backgroundColor: ui.sidebar },
    headerCell: { backgroundColor: ui.sidebar, color: ui.foreground, borderColor: ui.border },
    headerCellSorted: { backgroundColor: ui.card, color: ui.foreground },
    sortIndicator: { color: ui.mutedForeground },
    resizeHandle: { backgroundColor: ui.border },
    row: { backgroundColor: ui.background },
    rowOdd: { backgroundColor: ui.card },
    rowHover: { backgroundColor: ui.activeLine },
    rowSelected: { backgroundColor: ui.selection },
    cell: { color: ui.foreground, borderColor: ui.border },
    rowHeader: { backgroundColor: ui.sidebar, color: ui.mutedForeground, borderColor: ui.border },
    rowHeaderCorner: { backgroundColor: ui.sidebar, borderColor: ui.border },
    empty: { color: ui.mutedForeground },
  };
}

/** One file's table; PreviewBody makes a new one per file, so its sort starts unsorted. */
function TableBody(props: {
  file: Accessor<LoadedFile>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const f = props.file;
  const sort = signal<DataTableSort | null>(null);
  const sortedTableRows = computed(() =>
    sortRows(f().tableData?.rows ?? [], f().tableData?.columns ?? [], sort()),
  );
  const notice = computed(() => invalidLinesNotice(f().tableData?.invalidLines ?? []));
  const tableStyles = computed(() => buildTableStyles(props.theme()));

  return (
    <View class="flex-1" style={{ backgroundColor: props.theme().ui.background }}>
      <If when={notice()}>
        {(text) => (
          <Text
            testID="table-invalid-lines"
            style={{ color: props.theme().ui.mutedForeground }}
            class="px-3 py-1.5 text-xs truncate"
          >
            {text()}
          </Text>
        )}
      </If>
      <DataTable
        testID="preview-table"
        columns={f().tableData?.columns ?? []}
        data={sortedTableRows()}
        rowCount={sortedTableRows().length}
        sort={sort()}
        onSortChange={({ sort: next }) => sort.set(next)}
        stripe
        rowHeader
        styles={tableStyles()}
        classes={{
          headerCell: "font-medium border-b border-r px-3",
          cell: "border-b border-r px-3",
          rowHeader: "border-b border-r px-2",
          rowHeaderCorner: "border-b border-r",
        }}
        style={{ backgroundColor: props.theme().ui.background }}
        class="flex-1"
      />
    </View>
  );
}

function QuickLookBody(props: {
  file: Accessor<LoadedFile>;
  tab?: Accessor<TabEntry | undefined>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const initialZoom = untracked(() => props.tab?.()?.view.zoom() ?? 100);
  const zoom = createZoom(50, 300, 25, initialZoom);
  effect(() => {
    const z = zoom.value();
    untracked(() => props.tab?.()?.view.zoom.set(z));
  });
  const sheetWidth = computed(() => Math.round(580 * (zoom.value() / 100)));
  const sheetHeight = computed(() => Math.round(750 * (zoom.value() / 100)));

  return (
    <View style={{ backgroundColor: props.theme().ui.background }} class="flex-1 relative">
      <If
        when={props.file().quickLookUrl}
        else={
          <View class="flex-1 items-center justify-center p-6 gap-2">
            <Text style={{ color: props.theme().ui.mutedForeground }} class="text-xs">
              Preview unavailable
            </Text>
          </View>
        }
      >
        {(url) => (
          <View class="flex-1">
            <Scroll class="flex-1" contentClass="grow items-center justify-center p-6">
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
            </Scroll>
            <ViewportPill zoom={zoom} zoomTestIdPrefix="quicklook" />
          </View>
        )}
      </If>
    </View>
  );
}

export function getActiveView(file: LoadedFile): string {
  if (file.mode === "diff") return "diff";
  if (file.mode === "source" || file.classification.kind === "code") return "editor";
  return file.classification.kind;
}

export function formatMediaMeta(file: LoadedFile): string {
  const dim = file.dimensions;
  const dimText = dim ? `${dim.width} × ${dim.height} · ` : "";
  return `${dimText}${file.classification.mimeType}`;
}

/** Resolve backdrop color and action label so `"Dark BG"` / `"Light BG"` always names the target polarity. */
export function resolveImageBackdrop(
  appearance: "light" | "dark",
  defaultBg: string,
  contrast: boolean,
): { backgroundColor: string; toggleLabel: "Dark BG" | "Light BG" } {
  if (!contrast) {
    return {
      backgroundColor: defaultBg,
      toggleLabel: appearance === "light" ? "Dark BG" : "Light BG",
    };
  }
  return appearance === "light"
    ? { backgroundColor: "#1d1c1a", toggleLabel: "Light BG" }
    : { backgroundColor: "#f7f4ee", toggleLabel: "Dark BG" };
}

function readInitialImageView(tab?: Accessor<TabEntry | undefined>): {
  zoom: number;
  contrast: boolean;
} {
  const t = tab?.();
  return { zoom: t ? t.view.zoom() : 100, contrast: t ? t.view.contrastBg() : false };
}

function writeTabImageView(
  tab: Accessor<TabEntry | undefined> | undefined,
  zoom: number,
  contrast: boolean,
): void {
  const t = tab?.();
  if (!t) return;
  t.view.zoom.set(zoom);
  t.view.contrastBg.set(contrast);
}

function ImageBody(props: {
  file: Accessor<LoadedFile>;
  tab?: Accessor<TabEntry | undefined>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const init = untracked(() => readInitialImageView(props.tab));
  const zoom = createZoom(25, 400, 25, init.zoom);
  const contrastBg = signal(init.contrast);
  effect(() => {
    const z = zoom.value();
    const c = contrastBg();
    untracked(() => writeTabImageView(props.tab, z, c));
  });

  const backdrop = computed(() =>
    resolveImageBackdrop(
      props.theme().appearance,
      props.theme().ui.background,
      contrastBg(),
    ),
  );
  const scaledSize = computed(() => {
    const dim = props.file().dimensions;
    const ratio = zoom.value() / 100;
    return {
      width: Math.round((dim ? dim.width : 640) * ratio),
      height: Math.round((dim ? dim.height : 480) * ratio),
    };
  });

  return (
    <View
      testID="preview-image-container"
      style={{ backgroundColor: backdrop().backgroundColor }}
      class="flex-1 relative"
    >
      <Scroll class="flex-1" contentClass="grow items-center justify-center p-6">
        <Scroll horizontal contentClass="grow items-center justify-center">
          <If when={props.file().blobUrl}>
            {(url) => (
              <View class="items-center justify-center" style={scaledSize()}>
                <Image
                  testID="preview-image"
                  src={url()}
                  class="w-full h-full"
                  style={{ objectFit: "contain" }}
                />
              </View>
            )}
          </If>
        </Scroll>
      </Scroll>
      <ViewportPill zoom={zoom} zoomTestIdPrefix="image">
        <SurfaceButton
          size="sm"
          testID="image-bg-toggle"
          label={backdrop().toggleLabel}
          onPress={() => contrastBg.update((v) => !v)}
        />
      </ViewportPill>
    </View>
  );
}

function VideoBody(props: { file: Accessor<LoadedFile> }): JSX.Element {
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
          <Icon name="music" size={20} tint={() => props.theme().ui.accent} />
        </View>
        <View class="items-center gap-1">
          <Text style={{ color: props.theme().ui.foreground }} class="text-sm font-medium">
            {props.file().name}
          </Text>
          <Text style={{ color: props.theme().ui.mutedForeground }} class="text-xs font-mono">
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

function resolveEditorInstanceKey(
  file: LoadedFile,
  tab: TabEntry | undefined,
): string {
  return tab ? `${tab.id}\u0000${tab.doc.reloadSeq()}` : `${file.path}\u00000`;
}

function resolvePaneFontStyle(paneProps: PreviewPaneProps): {
  fontFamily?: string;
  fontSize: number;
} {
  return {
    fontFamily: paneProps.fontFamily?.() || undefined,
    fontSize: paneProps.fontSize?.() ?? 13,
  };
}

function resolveTabKey(file: LoadedFile, tab: TabEntry | undefined): string {
  return tab ? tab.id : file.path;
}

function isEditorFindVisible(open: boolean, file: LoadedFile | undefined): boolean {
  return open && file !== undefined && getActiveView(file) === "editor";
}

function buildSearchQuery(
  open: boolean,
  query: string,
): { query: string; caseSensitive: boolean } | undefined {
  return open && query.length > 0 ? { query, caseSensitive: false } : undefined;
}

function PreviewBody(props: {
  file: Accessor<LoadedFile>;
  tab?: Accessor<TabEntry | undefined>;
  diffLayout: Signal<DiffLayout>;
  search: Accessor<{ query: string; caseSensitive: boolean } | undefined>;
  findShown: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
  paneProps: PreviewPaneProps;
  onSearchResult: (res: EditorSearchResult) => void;
  onEditorRef: (ref: EditorRef, mounted: boolean) => void;
  onEditorFocusChange: (focused: boolean) => void;
}): JSX.Element {
  const activeView = computed(() => getActiveView(props.file()));
  const isVectorPreview = computed(
    () => activeView() === "markdown" || activeView() === "mermaid",
  );
  const previewMounted = signal(false);
  effect(() => {
    if (isVectorPreview()) previewMounted.set(true);
  });

  const fontStyle = computed(() => resolvePaneFontStyle(props.paneProps));
  const currentTab = () => (props.tab ? props.tab() : undefined);
  const tabKey = computed(() => resolveTabKey(props.file(), currentTab()));
  const editorKey = computed(() => resolveEditorInstanceKey(props.file(), currentTab()));

  return (
    <View class="flex-1" style={{ backgroundColor: props.theme().ui.background }}>
      <If when={activeView() === "diff"}>
        <DiffBody
          file={props.file}
          diffLayout={props.diffLayout}
          fontStyle={fontStyle}
          theme={props.theme}
        />
      </If>
      <If when={activeView() === "quicklook"}>
        <Each of={[tabKey()]} key={(k) => k}>
          {() => <QuickLookBody file={props.file} tab={props.tab} theme={props.theme} />}
        </Each>
      </If>
      <If when={activeView() === "table"}>
        <Each of={[tabKey()]} key={(k) => k}>
          {() => <TableBody file={props.file} theme={props.theme} />}
        </Each>
      </If>
      <If when={activeView() === "binary"}>
        <Editor
          testID="preview-hex"
          value={props.file().hexDump}
          readOnly
          language="plaintext"
          lineNumbers={false}
          scrollBeyondLastLine={8}
          fontFamily={fontStyle().fontFamily}
          fontSize={fontStyle().fontSize}
          lineHeight={Math.round(fontStyle().fontSize * 1.54)}
          styles={buildEditorThemeStyles(props.theme())}
          classes={{ line: "whitespace-nowrap" }}
          style={{ backgroundColor: props.theme().ui.background }}
          class="flex-1"
        />
      </If>
      {/* Single keep-alive sandboxed vector WebView serving both `.md` and `.mmd`. */}
      <View
        style={{
          display: isVectorPreview() ? "flex" : "none",
          flex: 1,
          flexDirection: "column",
        }}
      >
        <If when={previewMounted()}>
          <MarkdownPreview
            file={props.file}
            theme={props.theme}
            fontStyle={fontStyle}
            zoom={currentTab()?.view.zoom}
            onOpenRelativeLink={props.paneProps.onOpenRelativeLink}
          />
        </If>
      </View>
      <If when={activeView() === "html"}>
        <WebView
          testID="preview-webview"
          html={withPreviewCsp(props.file().text)}
          javaScriptEnabled={false}
          class="flex-1"
        />
      </If>
      <If when={activeView() === "image"}>
        <Each of={[tabKey()]} key={(k) => k}>
          {() => <ImageBody file={props.file} tab={props.tab} theme={props.theme} />}
        </Each>
      </If>
      <If when={activeView() === "video"}>
        <VideoBody file={props.file} />
      </If>
      <If when={activeView() === "audio"}>
        <AudioBody file={props.file} theme={props.theme} />
      </If>
      <If when={activeView() === "editor"}>
        <Each of={[editorKey()]} key={(k) => k}>
          {() => (
            <EditorBody
              file={props.file}
              search={props.search}
              findShown={props.findShown}
              fontStyle={fontStyle}
              theme={props.theme}
              onTextChange={(val) => props.paneProps.onTextChange(props.file().path, val)}
              onCursorChange={props.paneProps.onCursorChange}
              onSearchResult={props.onSearchResult}
              onEditorRef={props.onEditorRef}
              reveal={props.paneProps.reveal}
              onRevealed={props.paneProps.onRevealed}
              onFocusChange={props.onEditorFocusChange}
            />
          )}
        </Each>
      </If>
    </View>
  );
}

export function PreviewPane(props: PreviewPaneProps): JSX.Element {
  const findOpen = signal(false);
  const findQuery = signal("");
  const searchResult = signal<EditorSearchResult | null>(null);
  const editorFocused = signal(false);
  const diffLayout = signal<DiffLayout>("split");
  let activeEditorRef: EditorRef | null = null;

  const activeTheme = computed(() => (props.theme ? props.theme() : EDITOR_THEMES[0]));
  const findShown = computed(() => isEditorFindVisible(findOpen(), props.file()));
  const searchParam = computed(() => buildSearchQuery(findOpen(), findQuery()));

  cleanup(
    keymap.bind("mod+f", () => {
      if (findShown()) findOpen.set(false);
      else if (editorFocused()) findOpen.set(true);
    }),
  );

  effect(() => {
    if (!findQuery()) searchResult.set(null);
  });

  const handleEditorRef = (r: EditorRef, mounted: boolean) => {
    if (mounted) {
      activeEditorRef = r;
    } else if (activeEditorRef === r) {
      activeEditorRef = null;
      editorFocused.set(false);
    }
  };
  const currentFile = () => props.file()!;

  return (
    <View class="flex-1" style={{ backgroundColor: activeTheme().ui.background }}>
      <If when={props.file() !== undefined}>
        <View class="flex-1">
          <If when={findShown()}>
            <FindBar
              findOpen={findOpen}
              findQuery={findQuery}
              searchResult={searchResult}
              theme={activeTheme}
              onRunEditorCmd={(cmd) => activeEditorRef?.run(cmd)}
            />
          </If>
          <PreviewBody
            file={currentFile}
            tab={props.tab}
            diffLayout={diffLayout}
            search={searchParam}
            findShown={findShown}
            theme={activeTheme}
            paneProps={props}
            onSearchResult={(res) => searchResult.set(res)}
            onEditorRef={handleEditorRef}
            onEditorFocusChange={(focused) => editorFocused.set(focused)}
          />
        </View>
      </If>
    </View>
  );
}
