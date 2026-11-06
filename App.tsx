import * as os from "os";
import path from "path";
import {
  Canvas,
  cleanup,
  computed,
  effect,
  keymap,
  mount,
  Scroll,
  setColorScheme,
  signal,
  Storage,
  Text,
  View,
  type Accessor,
  type JSX,
  type Signal,
} from "nsh";
import {
  Button,
  Dialog,
  Input,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  type CommandItem,
} from "nsh/base";
import {
  isAvailable as desktopAvailable,
  Menu as DesktopMenu,
  titleBar,
  Window,
} from "nsh/desktop";
import type { PreviewMode } from "./src/classify";
import { AppLogo, FileBadge, Icon } from "./src/icons";
import { formatMediaMeta, PreviewPane } from "./src/PreviewPane";
import { CommandPalette, Sidebar } from "./src/Sidebar";
import {
  discoverTerminalEnvironment,
  TerminalPane,
  type ShellProfile,
} from "./src/TerminalPane";
import {
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  fontDisplayName,
  getThemeById,
  type EditorTheme,
} from "./src/themes";
import {
  consumeFinderOpenQueue,
  getFileDiffPatch,
  getInitialOpenFile,
  getInitialWorkspaceRoot,
  loadFile,
  lookupGitStatus,
  pickWorkspaceFolder,
  saveFileText,
  scanWorkspace,
  shortenHomePath,
  type GitStatusCode,
  type LoadedFile,
  type WorkspaceSnapshot,
} from "./src/workspace";

const DEFAULT_FONT_FAMILY = "JetBrainsMono Nerd Font Mono";
const DEFAULT_FONT_SIZE = 13;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;

const FONT_FAMILY_PRESETS = [
  "JetBrainsMono Nerd Font Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Fira Code",
  "Cascadia Code",
  "Courier New",
];

const builtInCommands: CommandItem[] = [
  { id: "configure-font", label: "Preferences: Theme, Font & Terminal...", keywords: ["font", "size", "family", "theme", "color", "shell"] },
  { id: "font-size-inc", label: "View: Increase Font Size", shortcut: "mod+=", keywords: ["font", "zoom", "larger"] },
  { id: "font-size-dec", label: "View: Decrease Font Size", shortcut: "mod+-", keywords: ["font", "zoom", "smaller"] },
  { id: "toggle-sidebar", label: "View: Toggle Sidebar", shortcut: "mod+b", keywords: ["sidebar", "explorer"] },
  { id: "toggle-terminal", label: "View: Toggle Terminal", shortcut: "mod+j", keywords: ["terminal", "pty", "console"] },
  { id: "open-folder", label: "File: Open Folder...", shortcut: "mod+o", keywords: ["open", "folder", "workspace"] },
  { id: "save-file", label: "File: Save Current File", shortcut: "mod+s", keywords: ["save", "write"] },
  { id: "close-tab", label: "View: Close Current Tab", shortcut: "mod+w", keywords: ["close", "tab"] },
  { id: "toggle-theme", label: "Preferences: Cycle Color Theme", keywords: ["theme", "light", "dark", "color"] },
  { id: "refresh-workspace", label: "Explorer: Refresh Workspace", keywords: ["refresh", "reload"] },
  { id: "mode-preview", label: "View: Switch to Preview Mode", keywords: ["preview"] },
  { id: "mode-source", label: "View: Switch to Source Mode", keywords: ["source", "code"] },
  { id: "mode-diff", label: "View: Switch to Diff Mode", keywords: ["diff", "git"] },
];

function hasRichPreview(file?: LoadedFile): boolean {
  if (!file) return false;
  const kind = file.classification.kind;
  if (
    kind === "markdown" ||
    kind === "mermaid" ||
    kind === "table" ||
    kind === "html"
  ) {
    return true;
  }
  return kind === "image" && file.classification.mimeType === "image/svg+xml";
}

function getRawModeLabel(file?: LoadedFile): string {
  if (!file) return "Code";
  if (file.classification.kind === "markdown") return "Markdown";
  return "Code";
}

function TabItem(props: {
  path: Accessor<string>;
  activePath: Accessor<string | null>;
  loadedFiles: Accessor<Record<string, LoadedFile>>;
  theme: Accessor<EditorTheme>;
  onSelect: () => void;
  onClose: () => void;
}): JSX.Element {
  const file = computed(() => props.loadedFiles()[props.path()]);
  const isActive = computed(() => props.path() === props.activePath());
  const isDirty = computed(() => !!file()?.dirty);
  const name = computed(
    () => file()?.name || props.path().split("/").filter(Boolean).pop() || props.path()
  );

  return (
    <View
      style={{
        backgroundColor: isActive()
          ? props.theme().ui.background
          : "transparent",
      }}
      class="h-9 px-3 flex-row items-center gap-2 shrink-0 select-none"
    >
      <If when={isActive()}>
        <View
          style={{ backgroundColor: props.theme().ui.accent }}
          class="absolute left-0 right-0 top-0 h-[2px]"
        />
      </If>
      <Button
        testID={`tab-select-${name()}`}
        onPress={props.onSelect}
        class="h-full px-0.5 flex-row items-center gap-2 bg-transparent border-none shadow-none"
      >
        <FileBadge
          name={name}
          color={() => props.theme().ui.mutedForeground}
        />
        <Text
          style={{
            color: isActive()
              ? props.theme().ui.foreground
              : props.theme().ui.mutedForeground,
          }}
          class={`text-xs ${isActive() ? "font-medium" : "font-normal"}`}
        >
          {name()}
        </Text>
        <If when={isDirty()}>
          <Text
            style={{ color: props.theme().ui.accent }}
            class="font-medium text-xs leading-none"
          >
            •
          </Text>
        </If>
      </Button>
      <Button
        testID={`tab-close-${name()}`}
        onPress={props.onClose}
        class="h-4 w-4 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
      >
        <Icon
          name="close"
          size={10}
          tint={() => props.theme().ui.mutedForeground}
        />
      </Button>
    </View>
  );
}

function ModePillBtn(props: {
  id: string;
  label: string;
  mode: PreviewMode;
  currentMode: Accessor<PreviewMode>;
  theme: Accessor<EditorTheme>;
  onSelect: (mode: PreviewMode) => void;
}): JSX.Element {
  const active = computed(() => props.currentMode() === props.mode);
  return (
    <Button
      testID={props.id}
      selected={active()}
      onPress={() => props.onSelect(props.mode)}
      style={{
        backgroundColor: active() ? props.theme().ui.sidebar : "transparent",
      }}
      class="h-5 px-2 rounded border-none shadow-none"
    >
      <Text
        style={{
          color: active()
            ? props.theme().ui.foreground
            : props.theme().ui.mutedForeground,
        }}
        class={`text-[11px] ${active() ? "font-medium" : "font-normal"}`}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function WindowTitleBar(props: {
  leftPad: Accessor<number>;
  root: Accessor<string>;
  theme: Accessor<EditorTheme>;
  sidebarOpen: Accessor<boolean>;
  terminalOpen: Accessor<boolean>;
  onQuickOpen: () => void;
  onOpenFolder: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
}): JSX.Element {
  const folderName = computed(() => {
    const raw = props.root();
    if (!raw) return "Open Folder";
    const parts = raw.split("/").filter(Boolean);
    return parts[parts.length - 1] || "workspace";
  });

  return (
    <View
      desktop={{ windowDrag: true }}
      class="h-8 flex-row items-center justify-between pr-3 shrink-0 select-none"
      style={{
        paddingLeft: props.leftPad(),
        backgroundColor: props.theme().ui.sidebar,
      }}
    >
      <View class="flex-1 flex-row items-center justify-center min-w-0 px-3">
        <Button
          testID="titlebar-quick-open"
          onPress={() => (props.root() ? props.onQuickOpen() : props.onOpenFolder())}
          style={{ backgroundColor: props.theme().ui.background }}
          class="flex-1 max-w-[320px] min-w-0 h-6 px-3 rounded hover:opacity-90 border-none flex-row items-center justify-center gap-2 shadow-none overflow-hidden"
        >
          <Icon
            name="search"
            size={12}
            tint={() => props.theme().ui.mutedForeground}
          />
          <Text
            style={{ color: props.theme().ui.mutedForeground }}
            class="text-xs truncate"
          >
            {folderName()}
          </Text>
        </Button>
      </View>
      <View class="flex-row items-center gap-1 shrink-0">
        <Button
          testID="titlebar-toggle-sidebar"
          onPress={props.onToggleSidebar}
          class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
        >
          <Icon
            name="sidebar"
            size={14}
            tint={() =>
              props.sidebarOpen() && !!props.root()
                ? props.theme().ui.foreground
                : props.theme().ui.mutedForeground
            }
          />
        </Button>
        <Button
          testID="titlebar-toggle-terminal"
          onPress={props.onToggleTerminal}
          class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
        >
          <Icon
            name="panel-bottom"
            size={14}
            tint={() =>
              props.terminalOpen()
                ? props.theme().ui.foreground
                : props.theme().ui.mutedForeground
            }
          />
        </Button>
      </View>
    </View>
  );
}

function EditorBreadcrumbBar(props: {
  activeFile: Accessor<LoadedFile | undefined>;
  theme: Accessor<EditorTheme>;
  onModeChange: (mode: PreviewMode) => void;
}): JSX.Element {
  const showPreviewToggle = computed(() => hasRichPreview(props.activeFile()));
  const isDiffMode = computed(
    () =>
      props.activeFile()?.mode === "diff" &&
      props.activeFile()?.classification.kind !== "diff"
  );
  const currentMode = computed<PreviewMode>(
    () => props.activeFile()?.mode ?? "preview"
  );
  const rawLabel = computed(() => getRawModeLabel(props.activeFile()));
  const dirParts = computed(() => {
    const rel = props.activeFile()?.relPath ?? "";
    const parts = rel.split("/").filter(Boolean);
    return parts.slice(0, -1);
  });

  return (
    <View
      class="h-7 px-3 flex-row items-center justify-between"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <View class="flex-row items-center gap-1 flex-1 min-w-0">
        <Each of={dirParts()} key={(seg, idx) => `${idx}-${seg}`}>
          {(seg) => (
            <View class="flex-row items-center gap-1 shrink-0">
              <Text
                style={{ color: props.theme().ui.mutedForeground }}
                class="text-xs"
              >
                {seg()}
              </Text>
              <Icon
                name="chevron-right"
                size={10}
                tint={() => props.theme().ui.mutedForeground}
              />
            </View>
          )}
        </Each>
        <FileBadge
          name={() => props.activeFile()?.name ?? ""}
          color={() => props.theme().ui.mutedForeground}
        />
        <Text
          style={{ color: props.theme().ui.mutedForeground }}
          class="text-xs truncate"
        >
          {props.activeFile()?.name ?? ""}
        </Text>
      </View>

      <If when={showPreviewToggle()}>
        <View class="flex-row items-center gap-1 shrink-0">
          <ModePillBtn
            id="mode-preview"
            label="Preview"
            mode="preview"
            currentMode={currentMode}
            theme={props.theme}
            onSelect={props.onModeChange}
          />
          <ModePillBtn
            id="mode-source"
            label={rawLabel()}
            mode="source"
            currentMode={currentMode}
            theme={props.theme}
            onSelect={props.onModeChange}
          />
        </View>
      </If>

      <If when={!showPreviewToggle() && isDiffMode()}>
        <View class="flex-row items-center gap-1 shrink-0">
          <ModePillBtn
            id="mode-diff"
            label="Diff"
            mode="diff"
            currentMode={currentMode}
            theme={props.theme}
            onSelect={props.onModeChange}
          />
          <ModePillBtn
            id="mode-source"
            label="Code"
            mode="source"
            currentMode={currentMode}
            theme={props.theme}
            onSelect={props.onModeChange}
          />
        </View>
      </If>
    </View>
  );
}

function EditorHeader(props: {
  tabs: Accessor<string[]>;
  activePath: Accessor<string | null>;
  loadedFiles: Accessor<Record<string, LoadedFile>>;
  activeFile: Accessor<LoadedFile | undefined>;
  theme: Accessor<EditorTheme>;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onModeChange: (mode: PreviewMode) => void;
}): JSX.Element {
  return (
    <View
      class="flex-col shrink-0 select-none"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <If when={props.tabs().length > 0}>
        <View
          class="h-9 flex-row items-center"
          style={{ backgroundColor: props.theme().ui.sidebar }}
        >
          <Scroll horizontal class="flex-1 shrink min-w-0">
            <View class="flex-row items-stretch h-9">
              <Each of={props.tabs()} key={(path) => path}>
                {(tabPath) => (
                  <TabItem
                    path={tabPath}
                    activePath={props.activePath}
                    loadedFiles={props.loadedFiles}
                    theme={props.theme}
                    onSelect={() => props.onSelectTab(tabPath())}
                    onClose={() => props.onCloseTab(tabPath())}
                  />
                )}
              </Each>
            </View>
          </Scroll>
        </View>
      </If>

      <If when={props.activeFile() !== undefined}>
        <EditorBreadcrumbBar
          activeFile={props.activeFile}
          theme={props.theme}
          onModeChange={props.onModeChange}
        />
      </If>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getContextAwareInfo(
  file: LoadedFile | undefined,
  line: number,
  col: number
): string {
  if (!file) return "";
  const size = formatBytes(file.size);
  const kind = file.classification.kind;
  if (kind === "image" || kind === "video" || kind === "audio") {
    return `${file.relPath} · ${size} · ${formatMediaMeta(file)}`;
  }
  if (kind === "quicklook") {
    const ext = file.name.split(".").pop()?.toUpperCase() || "PDF";
    return `${file.relPath} · ${size} · ${ext}`;
  }
  if (kind === "table") {
    const rowCount = file.tableData?.rows.length ?? 0;
    return `${file.relPath} · ${rowCount} rows`;
  }
  if (kind === "code" || kind === "markdown" || kind === "mermaid") {
    const lang = file.classification.language || kind;
    return `${file.relPath} · ${size} · Ln ${line}, Col ${col} · ${lang}`;
  }
  return `${file.relPath} · ${size}`;
}

function shortFontLabel(family: string, size: number): string {
  return `${fontDisplayName(family)} · ${size}px`;
}

function ThemeSelectOptionRow(props: {
  optionId: string;
  selected: boolean;
  highlighted: boolean;
  activeTheme: Accessor<EditorTheme>;
}): JSX.Element {
  const opt = getThemeById(props.optionId);
  const current = props.activeTheme();
  return (
    <View
      testID={`theme-option-${opt.id}`}
      style={{
        backgroundColor:
          props.highlighted || props.selected
            ? current.ui.selection
            : "transparent",
      }}
      class="h-7 px-2.5 rounded flex-row items-center justify-between gap-2.5 select-none"
    >
      <View class="flex-row items-center gap-2 min-w-0">
        <View
          style={{
            backgroundColor: opt.ui.background,
            borderColor: opt.ui.border,
          }}
          class="px-1.5 py-0.5 rounded border flex-row items-center gap-1 shrink-0"
        >
          <View
            class="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: opt.syntax.keyword }}
          />
          <View
            class="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: opt.syntax.string }}
          />
          <View
            class="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: opt.syntax.function }}
          />
        </View>
        <Text
          style={{ color: current.ui.foreground }}
          class={`text-xs font-mono truncate ${
            props.selected ? "font-semibold" : "font-normal"
          }`}
        >
          {opt.name}
        </Text>
      </View>
      <View class="w-3.5 items-center justify-center shrink-0">
        <If when={props.selected}>
          <Icon name="check" size={11.5} tint={current.ui.accent} />
        </If>
      </View>
    </View>
  );
}

function FontSelectOptionRow(props: {
  family: string;
  selected: boolean;
  highlighted: boolean;
  activeTheme: Accessor<EditorTheme>;
}): JSX.Element {
  const ui = props.activeTheme().ui;
  return (
    <View
      testID={`font-option-${props.family.split(/\s+/)[0]}`}
      style={{
        backgroundColor:
          props.highlighted || props.selected ? ui.selection : "transparent",
      }}
      class="h-7 px-2.5 rounded flex-row items-center justify-between gap-2.5 select-none"
    >
      <Text
        style={{ color: ui.foreground, fontFamily: props.family }}
        class="text-xs truncate"
      >
        {props.family}
      </Text>
      <View class="w-3.5 items-center justify-center shrink-0">
        <If when={props.selected}>
          <Icon name="check" size={11.5} tint={ui.accent} />
        </If>
      </View>
    </View>
  );
}

function StatusBar(props: {
  root: Accessor<string>;
  branch: Accessor<string>;
  changedCount: Accessor<number>;
  activeFile: Accessor<LoadedFile | undefined>;
  line: Accessor<number>;
  col: Accessor<number>;
  fontFamily: Accessor<string>;
  fontSize: Accessor<number>;
  theme: Accessor<EditorTheme>;
  onSelectTheme: (themeId: string) => void;
  onSelectFont: (family: string) => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
}): JSX.Element {
  const contextInfo = computed(() =>
    getContextAwareInfo(props.activeFile(), props.line(), props.col())
  );
  const statusInk = computed(
    () => props.theme().ui.statusBarForeground ?? props.theme().ui.mutedForeground
  );
  const fontBadge = computed(() =>
    shortFontLabel(props.fontFamily(), props.fontSize())
  );
  const themeOptions = EDITOR_THEMES.map((t) => ({
    value: t.id,
    title: t.name,
  }));
  const fontOptions = computed(() => {
    const current = props.fontFamily();
    const families = FONT_FAMILY_PRESETS.includes(current)
      ? FONT_FAMILY_PRESETS
      : [current, ...FONT_FAMILY_PRESETS];
    return families.map((f) => ({ value: f, title: f }));
  });

  return (
    <View
      class="h-6 px-3 select-none flex-row items-center justify-between shrink-0"
      style={{
        backgroundColor: props.theme().ui.statusBar ?? props.theme().ui.sidebar,
      }}
    >
      <View class="flex-row items-center gap-2">
        <If when={!!props.root()}>
          <View class="flex-row items-center gap-1">
            <Icon name="branch" size={12} tint={statusInk} />
            <Text class="text-[11px] font-mono" style={{ color: statusInk() }}>
              {props.branch() || "main"}
              {props.changedCount() > 0 ? "*" : ""}
            </Text>
          </View>
          <Button
            testID="sidebar-refresh"
            onPress={props.onRefresh}
            class="h-4 w-4 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
          >
            <Icon name="refresh" size={11} tint={statusInk} />
          </Button>
        </If>
      </View>

      <View class="flex-row items-center gap-3">
        <If when={!!contextInfo()}>
          <Text class="text-[11px] font-mono" style={{ color: statusInk() }}>
            {contextInfo()}
          </Text>
        </If>
        <Select
          testID="statusbar-theme-select"
          value={props.theme().id}
          items={themeOptions}
          placement="top"
          align="end"
          offset={6}
          onChange={({ value }) => {
            if (value) props.onSelectTheme(value);
          }}
          popupClass="w-56 rounded-lg shadow-2xl p-1"
          popupStyle={{
            backgroundColor: props.theme().ui.card,
          }}
          itemClass="rounded cursor-pointer"
          renderItem={(item) => (
            <ThemeSelectOptionRow
              optionId={item.value}
              selected={item.selected}
              highlighted={item.highlighted}
              activeTheme={props.theme}
            />
          )}
          trigger={
            <View
              testID="statusbar-theme-trigger"
              class="h-4 px-1.5 rounded flex-row items-center gap-1.5 hover:bg-white/10"
            >
              <View
                class="w-2 h-2 rounded-full"
                style={{ backgroundColor: props.theme().ui.accent }}
              />
              <Text class="text-[11px] font-mono" style={{ color: statusInk() }}>
                {props.theme().name}
              </Text>
            </View>
          }
          class="h-4"
        />
        <Select
          testID="statusbar-font-select"
          value={props.fontFamily()}
          items={fontOptions()}
          placement="top"
          align="end"
          offset={6}
          onChange={({ value }) => {
            if (value) props.onSelectFont(value);
          }}
          popupClass="w-64 rounded-lg shadow-2xl p-1"
          popupStyle={{
            backgroundColor: props.theme().ui.card,
          }}
          itemClass="rounded cursor-pointer"
          renderItem={(item) => (
            <FontSelectOptionRow
              family={item.value}
              selected={item.selected}
              highlighted={item.highlighted}
              activeTheme={props.theme}
            />
          )}
          trigger={
            <View
              testID="statusbar-font-trigger"
              class="h-4 px-1.5 rounded flex-row items-center hover:bg-white/10"
            >
              <Text class="text-[11px] font-mono" style={{ color: statusInk() }}>
                {fontBadge()}
              </Text>
            </View>
          }
          class="h-4"
        />
        <Button
          testID="titlebar-toggle-theme"
          onPress={props.onToggleTheme}
          class="h-4 w-4 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
        >
          <Icon name="sun" size={12} tint={statusInk} />
        </Button>
      </View>
    </View>
  );
}

function ThemeSwatchRow(props: {
  activeThemeId: Accessor<string>;
  onSelectTheme: (id: string) => void;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap gap-2">
      <Each of={EDITOR_THEMES} key={(t) => t.id}>
        {(t) => (
          <Button
            testID={`theme-preset-${t().id}`}
            onPress={() => props.onSelectTheme(t().id)}
            style={{
              backgroundColor: t().ui.background,
              borderColor:
                props.activeThemeId() === t().id ? t().ui.accent : t().ui.border,
            }}
            class="h-7 px-3 rounded border flex-row items-center gap-2 shadow-none"
          >
            <View class="flex-row items-center gap-1">
              <View
                class="w-2 h-2 rounded-full"
                style={{ backgroundColor: t().syntax.keyword }}
              />
              <View
                class="w-2 h-2 rounded-full"
                style={{ backgroundColor: t().syntax.string }}
              />
              <View
                class="w-2 h-2 rounded-full"
                style={{ backgroundColor: t().syntax.function }}
              />
            </View>
            <Text
              style={{ color: t().ui.foreground }}
              class={`text-[11px] ${
                props.activeThemeId() === t().id ? "font-medium" : "font-normal"
              }`}
            >
              {t().name}
            </Text>
          </Button>
        )}
      </Each>
    </View>
  );
}

function FontSettingsDialog(props: {
  open: Signal<boolean>;
  fontFamily: Signal<string>;
  fontSize: Signal<number>;
  themeId: Accessor<string>;
  theme: Accessor<EditorTheme>;
  defaultShell: Signal<string>;
  shells: Accessor<ShellProfile[]>;
  onSetTheme: (id: string) => void;
  onSetFamily: (family: string) => void;
  onAdjustSize: (delta: number) => void;
  onSetShell: (shellPath: string) => void;
  onReset: () => void;
}): JSX.Element {
  return (
    <If when={props.open()}>
      <Dialog
        open={props.open()}
        onCancel={() => props.open.set(false)}
        closeOnEscape
        closeOnBackdropPress
        backdropClass="bg-black/45"
        class="items-center justify-start pt-16"
      >
        <View
          testID="font-settings-dialog"
          style={{ backgroundColor: props.theme().ui.card }}
          class="w-[480px] max-w-[92%] p-5 rounded-lg shadow-2xl gap-4 select-none"
        >
          <View class="flex-row items-center justify-between">
            <Text
              style={{ color: props.theme().ui.foreground }}
              class="text-sm font-medium"
            >
              Preferences
            </Text>
            <Button
              testID="font-dialog-close"
              onPress={() => props.open.set(false)}
              class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
            >
              <Icon
                name="close"
                size={12}
                tint={() => props.theme().ui.mutedForeground}
              />
            </Button>
          </View>

          <View class="gap-2">
            <Text
              style={{ color: props.theme().ui.mutedForeground }}
              class="text-xs"
            >
              Color theme
            </Text>
            <ThemeSwatchRow
              activeThemeId={props.themeId}
              onSelectTheme={props.onSetTheme}
            />
          </View>

          <View class="gap-2">
            <Text
              style={{ color: props.theme().ui.mutedForeground }}
              class="text-xs"
            >
              Font family
            </Text>
            <Input
              testID="font-family-input"
              value={props.fontFamily()}
              onChange={({ value }) => props.onSetFamily(value)}
              placeholder="Font family"
              style={{
                height: 28,
                fontFamily: props.fontFamily() || undefined,
                backgroundColor: props.theme().ui.background,
                color: props.theme().ui.foreground,
              }}
              class="w-full h-7 px-3 text-xs font-mono rounded border-none"
            />
            <View class="flex-row flex-wrap gap-2 pt-1">
              <Each of={FONT_FAMILY_PRESETS} key={(f) => f}>
                {(preset) => (
                  <Button
                    testID={`font-preset-${preset().split(/\s+/)[0]}`}
                    onPress={() => props.onSetFamily(preset())}
                    style={{
                      backgroundColor:
                        props.fontFamily() === preset()
                          ? props.theme().ui.accent
                          : props.theme().ui.sidebar,
                    }}
                    class="h-6 px-2.5 rounded border-none shadow-none"
                  >
                    <Text
                      style={{
                        fontFamily: preset(),
                        color:
                          props.fontFamily() === preset()
                            ? "#ffffff"
                            : props.theme().ui.foreground,
                      }}
                      class={`text-[11px] ${
                        props.fontFamily() === preset()
                          ? "font-medium"
                          : "font-normal"
                      }`}
                    >
                      {preset()}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <View class="flex-row items-center justify-between pt-1">
            <Text
              style={{ color: props.theme().ui.mutedForeground }}
              class="text-xs"
            >
              Font size
            </Text>
            <View class="flex-row items-center gap-2">
              <Button
                testID="font-size-dec"
                onPress={() => props.onAdjustSize(-1)}
                style={{ backgroundColor: props.theme().ui.sidebar }}
                class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
              >
                <Text
                  style={{ color: props.theme().ui.foreground }}
                  class="text-xs font-mono"
                >
                  -
                </Text>
              </Button>
              <Text
                testID="font-size-value"
                style={{ color: props.theme().ui.foreground }}
                class="w-12 text-center text-xs font-mono"
              >
                {`${props.fontSize()}px`}
              </Text>
              <Button
                testID="font-size-inc"
                onPress={() => props.onAdjustSize(1)}
                style={{ backgroundColor: props.theme().ui.sidebar }}
                class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
              >
                <Text
                  style={{ color: props.theme().ui.foreground }}
                  class="text-xs font-mono"
                >
                  +
                </Text>
              </Button>
              <Button
                testID="font-reset-btn"
                onPress={props.onReset}
                style={{ backgroundColor: props.theme().ui.sidebar }}
                class="h-6 px-2.5 ml-1 items-center justify-center rounded border-none shadow-none"
              >
                <Text
                  style={{ color: props.theme().ui.foreground }}
                  class="text-[11px]"
                >
                  Reset
                </Text>
              </Button>
            </View>
          </View>

          <View class="gap-2 pt-1">
            <Text
              style={{ color: props.theme().ui.mutedForeground }}
              class="text-xs"
            >
              Terminal shell
            </Text>
            <View class="flex-row flex-wrap gap-2">
              <Each of={props.shells()} key={(s) => s.path}>
                {(sh) => (
                  <Button
                    testID={`shell-preset-${sh().name}`}
                    onPress={() => props.onSetShell(sh().path)}
                    style={{
                      backgroundColor:
                        props.defaultShell() === sh().path
                          ? props.theme().ui.accent
                          : props.theme().ui.sidebar,
                    }}
                    class="h-6 px-2.5 rounded border-none shadow-none"
                  >
                    <Text
                      style={{
                        color:
                          props.defaultShell() === sh().path
                            ? "#ffffff"
                            : props.theme().ui.foreground,
                      }}
                      class={`text-[11px] font-mono ${
                        props.defaultShell() === sh().path
                          ? "font-medium"
                          : "font-normal"
                      }`}
                    >
                      {`${sh().name} (${sh().path})`}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <View
            style={{ backgroundColor: props.theme().ui.background }}
            class="p-3 rounded"
          >
            <Text
              style={{
                fontFamily: props.fontFamily() || undefined,
                fontSize: props.fontSize(),
                color: props.theme().ui.foreground,
              }}
              class="font-mono"
            >
              {"const greeting = () => '0O1lI != === =>';"}
            </Text>
          </View>
        </View>
      </Dialog>
    </If>
  );
}

// DESIGN.md「界面设计语言（Industrial）」: the welcome screen is a poster.
// Three flat fields carry the composition: a signal-red arch (right), an ink
// block (bottom left) that IS the primary action, and a stone quarter disc
// where they meet. Text sits on the paper, top left, on one grid.
const POSTER_FONT = "Helvetica Neue";

interface PosterBox {
  w: number;
  h: number;
}

/** The poster's grid, from the panel size: column split, block height, title size. */
function posterGrid(box: PosterBox): {
  w: number;
  h: number;
  pad: number;
  split: number;
  blockH: number;
  blockTop: number;
  title: number;
} {
  const w = Math.max(480, box.w);
  const h = Math.max(240, box.h);
  const pad = Math.round(Math.max(24, Math.min(64, Math.min(w, h) * 0.055)));
  const split = Math.round(Math.max(w * 0.48, Math.min(w - 140, 420)));
  const blockH = Math.round(Math.max(76, Math.min(200, h * 0.25)));
  const blockTop = h - blockH;
  const colW = Math.max(200, split - pad * 2);
  const availTitleH = Math.max(56, blockTop - pad - 56);
  const title = Math.round(
    Math.max(
      56,
      Math.min(104, colW / 2.4, availTitleH, h / 4.2)
    )
  );
  return { w, h, pad, split, blockH, blockTop, title };
}

function PosterFields(props: {
  box: Accessor<PosterBox>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <Canvas
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
      draw={(cx) => {
        const raw = props.box();
        if (raw.w <= 0 || raw.h <= 0) return;
        const ui = props.theme().ui;
        const g = posterGrid(raw);
        const { w, h } = g;
        // Signal arch: straight left edge from the block line up, one quarter
        // circle over to the right edge.
        const archTop = Math.round(h * 0.2);
        const r = Math.min(w - g.split, g.blockTop - archTop);
        cx.fillStyle = ui.accent;
        cx.beginPath();
        cx.moveTo(g.split, h);
        cx.lineTo(g.split, archTop + r);
        cx.arc(g.split + r, archTop + r, r, Math.PI, Math.PI * 1.5);
        cx.lineTo(w, archTop);
        cx.lineTo(w, h);
        cx.closePath();
        cx.fill();
        // Ink block: the primary action's field.
        cx.fillStyle = ui.foreground;
        cx.fillRect(0, g.blockTop, g.split, h - g.blockTop);
        // Stone quarter disc: centred on the block's top-right corner, it
        // fills the arch's foot from the block line down and to the right.
        const sr = Math.min(h - g.blockTop, (w - g.split) * 0.5);
        cx.fillStyle = ui.border;
        cx.beginPath();
        cx.moveTo(g.split, g.blockTop);
        cx.lineTo(g.split + sr, g.blockTop);
        cx.arc(g.split, g.blockTop, sr, 0, Math.PI / 2);
        cx.closePath();
        cx.fill();
      }}
    />
  );
}

function PosterRecent(props: {
  items: Accessor<string[]>;
  home: string;
  theme: Accessor<EditorTheme>;
  onSelect: (folderPath: string) => void;
}): JSX.Element {
  return (
    <View class="gap-1">
      <Text
        class="text-xs font-medium pb-1"
        style={{ color: props.theme().ui.mutedForeground, fontFamily: POSTER_FONT }}
      >
        Recent
      </Text>
      <Each of={props.items()} key={(w) => w}>
        {(ws, index) => (
          <Button
            testID={`welcome-recent-${path.basename(ws()) || ws()}`}
            onPress={() => props.onSelect(ws())}
            class="h-7 -mx-2 px-2 rounded flex-row items-center gap-3 bg-transparent hover:bg-foreground/5 active:bg-foreground/10 border-none shadow-none"
          >
            <Text
              class="w-5 text-[11px] font-mono shrink-0"
              style={{ color: props.theme().ui.accent }}
            >
              {String(index() + 1).padStart(2, "0")}
            </Text>
            <Text
              class="text-[13px] font-medium shrink-0"
              style={{ color: props.theme().ui.foreground, fontFamily: POSTER_FONT }}
            >
              {path.basename(ws()) || ws()}
            </Text>
            <Text
              class="text-[11px] font-mono flex-1 min-w-0 truncate"
              style={{ color: props.theme().ui.mutedForeground }}
            >
              {shortenHomePath(path.dirname(ws()), props.home)}
            </Text>
          </Button>
        )}
      </Each>
    </View>
  );
}

function WelcomePanel(props: {
  recentWorkspaces: Accessor<string[]>;
  theme: Accessor<EditorTheme>;
  onOpenFolder: () => void;
  onSelectRecentWorkspace: (folderPath: string) => void;
}): JSX.Element {
  const home = os.homedir();
  const box = signal<PosterBox>({ w: 0, h: 0 });
  const grid = computed(() => posterGrid(box()));
  // Recent rows that fit between the title and the ink block (28pt a row).
  const recentFit = computed(() => {
    const g = grid();
    const top = g.pad + g.title + 96;
    const rows = Math.floor((g.blockTop - 28 - top) / 28);
    return props.recentWorkspaces().slice(0, Math.max(0, Math.min(5, rows)));
  });
  const ui = () => props.theme().ui;

  return (
    <View
      testID="welcome-panel"
      class="flex-1 overflow-hidden select-none"
      style={{ backgroundColor: ui().background }}
      onLayout={({ bounds }) =>
        box.set({ w: Math.round(bounds.size.width), h: Math.round(bounds.size.height) })
      }
    >
      <PosterFields box={box} theme={props.theme} />

      <View
        class="absolute gap-5 overflow-hidden"
        style={{
          left: grid().pad,
          top: grid().pad,
          width: grid().split - grid().pad * 2,
          maxHeight: Math.max(0, grid().blockTop - grid().pad - 16),
        }}
      >
        <Text
          style={{
            color: ui().foreground,
            fontFamily: POSTER_FONT,
            fontWeight: "bold",
            fontSize: grid().title,
            lineHeight: Math.round(grid().title * 0.92),
            letterSpacing: -grid().title * 0.035,
          }}
        >
          Aed
        </Text>
        <Text
          class="text-[13px] max-w-[340px]"
          style={{ color: ui().mutedForeground, fontFamily: POSTER_FONT }}
        >
          Another editor for code, documents, data and media.
        </Text>
        <If when={recentFit().length > 0}>
          <View class="pt-4">
            <PosterRecent
              items={recentFit}
              home={home}
              theme={props.theme}
              onSelect={props.onSelectRecentWorkspace}
            />
          </View>
        </If>
      </View>

      <Button
        testID="welcome-open-folder"
        onPress={props.onOpenFolder}
        class="absolute justify-end bg-transparent hover:bg-white/5 active:bg-white/10 border-none shadow-none rounded-none"
        style={{
          left: 0,
          bottom: 0,
          width: grid().split,
          height: grid().blockH,
          paddingLeft: grid().pad,
          paddingBottom: Math.round(grid().pad * 0.8),
          paddingRight: grid().pad,
        }}
      >
        <Text
          style={{
            color: ui().background,
            fontFamily: POSTER_FONT,
            fontWeight: "bold",
            fontSize: 26,
            letterSpacing: -0.6,
          }}
        >
          Open Folder
        </Text>
      </Button>
    </View>
  );
}

function EmptyEditorShortcutRow(props: {
  id: string;
  label: string;
  shortcut: string;
  theme: Accessor<EditorTheme>;
  onPress: () => void;
}): JSX.Element {
  return (
    <Button
      testID={props.id}
      onPress={props.onPress}
      class="h-7 px-2.5 rounded flex-row items-center justify-between gap-8 bg-transparent hover:bg-white/5 border-none shadow-none"
    >
      <Text
        style={{ color: props.theme().ui.mutedForeground }}
        class="text-xs"
      >
        {props.label}
      </Text>
      <Text
        style={{ color: props.theme().ui.mutedForeground, opacity: 0.65 }}
        class="text-[11px] font-mono"
      >
        {props.shortcut}
      </Text>
    </Button>
  );
}

function EmptyEditorPanel(props: {
  theme: Accessor<EditorTheme>;
  onQuickOpen: () => void;
  onOpenFolder: () => void;
  onToggleTerminal: () => void;
}): JSX.Element {
  return (
    <View
      testID="empty-editor-panel"
      class="flex-1 items-center justify-center select-none"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <View class="w-[220px] flex-col gap-1 opacity-75">
        <EmptyEditorShortcutRow
          id="empty-editor-quick-open"
          label="Search Files"
          shortcut="⌘P"
          theme={props.theme}
          onPress={props.onQuickOpen}
        />
        <EmptyEditorShortcutRow
          id="empty-editor-open-folder"
          label="Open Folder"
          shortcut="⌘O"
          theme={props.theme}
          onPress={props.onOpenFolder}
        />
        <EmptyEditorShortcutRow
          id="empty-editor-toggle-terminal"
          label="Toggle Terminal"
          shortcut="⌘J"
          theme={props.theme}
          onPress={props.onToggleTerminal}
        />
      </View>
    </View>
  );
}

function isExternalOrHashUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("#")
  );
}

function resolveRelativeLink(relUrl: string, baseFilePath: string): string | null {
  if (isExternalOrHashUrl(relUrl)) return null;
  if (relUrl.startsWith("/")) return path.normalize(relUrl);
  return path.resolve(path.dirname(baseFilePath), relUrl);
}

interface AppActions {
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  openFolder: () => void;
  openQuickOpen: () => void;
  openCommandPalette: () => void;
  openFontSettings: () => void;
  adjustFontSize: (delta: number) => void;
  resetFont: () => void;
  saveCurrent: () => void;
  closeCurrent: () => void;
  toggleTheme: () => void;
  refresh: () => void;
  setMode: (mode: PreviewMode) => void;
}

const COMMAND_HANDLERS: Record<string, (actions: AppActions) => void> = {
  "configure-font": (a) => a.openFontSettings(),
  "font-size-inc": (a) => a.adjustFontSize(1),
  "font-size-dec": (a) => a.adjustFontSize(-1),
  "toggle-sidebar": (a) => a.toggleSidebar(),
  "toggle-terminal": (a) => a.toggleTerminal(),
  "open-folder": (a) => a.openFolder(),
  "save-file": (a) => a.saveCurrent(),
  "close-tab": (a) => a.closeCurrent(),
  "toggle-theme": (a) => a.toggleTheme(),
  "refresh-workspace": (a) => a.refresh(),
  "mode-preview": (a) => a.setMode("preview"),
  "mode-source": (a) => a.setMode("source"),
  "mode-diff": (a) => a.setMode("diff"),
};

let lastEnforcedKey = "";

function enforceMinWindowSize(width: number, height: number): void {
  if (!desktopAvailable || width <= 0 || height <= 0) return;
  const w = Math.round(width);
  const h = Math.round(height);
  if (w >= MIN_WINDOW_WIDTH && h >= MIN_WINDOW_HEIGHT) {
    lastEnforcedKey = "";
    return;
  }
  const key = `${w}x${h}`;
  if (key === lastEnforcedKey) return;
  lastEnforcedKey = key;
  Window.setFrame({
    size: {
      width: Math.max(w, MIN_WINDOW_WIDTH),
      height: Math.max(h, MIN_WINDOW_HEIGHT),
    },
  });
}

function setupDesktopChrome(actions: AppActions): void {
  if (!desktopAvailable) return;
  Window.setTitleBar({ style: "hidden" });
  Window.setTitle("Aed");
  Window.setFrame({ size: { width: 1280, height: 800 } });
  DesktopMenu.setApplicationMenu([
    {
      label: "Aed",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Font Settings...", shortcut: "mod+,", onSelect: () => actions.openFontSettings() },
        { type: "separator" },
        { role: "hide", shortcut: "mod+h" },
        { role: "hideOthers", shortcut: "mod+alt+h" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", shortcut: "mod+q" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Folder...", shortcut: "mod+o", onSelect: () => actions.openFolder() },
        { label: "Quick Open...", shortcut: "mod+p", onSelect: () => actions.openQuickOpen() },
        { type: "separator" },
        { label: "Save", shortcut: "mod+s", onSelect: () => actions.saveCurrent() },
        { label: "Close Tab", shortcut: "mod+w", onSelect: () => actions.closeCurrent() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", shortcut: "mod+z" },
        { role: "redo", shortcut: "mod+shift+z" },
        { type: "separator" },
        { role: "cut", shortcut: "mod+x" },
        { role: "copy", shortcut: "mod+c" },
        { role: "paste", shortcut: "mod+v" },
        { role: "selectAll", shortcut: "mod+a" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Command Palette...", shortcut: "mod+shift+p", onSelect: () => actions.openCommandPalette() },
        { type: "separator" },
        { label: "Toggle Sidebar", shortcut: "mod+b", onSelect: () => actions.toggleSidebar() },
        { label: "Toggle Terminal", shortcut: "mod+j", onSelect: () => actions.toggleTerminal() },
        { type: "separator" },
        { role: "toggleFullScreen", shortcut: "ctrl+mod+f" },
      ],
    },
  ]);
}

function decodeDroppedUri(uri: string | undefined): string | null {
  if (!uri) return null;
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
}

async function fetchOrReuseLoadedFile(
  current: Record<string, LoadedFile>,
  filePath: string,
  root: string,
  statusMap: Record<string, GitStatusCode>,
  openInDiff?: boolean
): Promise<LoadedFile> {
  const gitStatus = lookupGitStatus(filePath, root, statusMap);
  const existing = current[filePath];
  if (!existing) {
    return loadFile(filePath, root, openInDiff ? "diff" : undefined, gitStatus);
  }
  if (openInDiff && existing.mode !== "diff") {
    return resolveModeFile({ ...existing, gitStatus }, "diff", root);
  }
  return { ...existing, gitStatus };
}

async function resolveModeFile(
  file: LoadedFile,
  mode: PreviewMode,
  root: string
): Promise<LoadedFile> {
  const diffPatch =
    mode === "diff" && !file.diffPatch
      ? await getFileDiffPatch(file.path, root)
      : file.diffPatch;
  return { ...file, mode, diffPatch };
}

function bindAppShortcuts(actions: AppActions): () => void {
  return keymap.bind({
    "mod+p": () => actions.openQuickOpen(),
    "mod+k": () => actions.openQuickOpen(),
    "mod+shift+p": () => actions.openCommandPalette(),
    "mod+,": () => actions.openFontSettings(),
    "mod+b": () => actions.toggleSidebar(),
    "mod+j": () => actions.toggleTerminal(),
    "ctrl+`": () => actions.toggleTerminal(),
    "mod+s": () => actions.saveCurrent(),
    "mod+w": () => actions.closeCurrent(),
    "mod+o": () => actions.openFolder(),
    "mod+=": () => actions.adjustFontSize(1),
    "mod+-": () => actions.adjustFontSize(-1),
    "mod+0": () => actions.resetFont(),
  });
}

function updateFileTextInMap(
  loadedFiles: Signal<Record<string, LoadedFile>>,
  filePath: string,
  newText: string
): void {
  const file = loadedFiles()[filePath];
  if (!file) return;
  loadedFiles.set({
    ...loadedFiles(),
    [filePath]: { ...file, text: newText, dirty: newText !== file.savedText },
  });
}

async function updateFileModeInMap(
  loadedFiles: Signal<Record<string, LoadedFile>>,
  filePath: string,
  mode: PreviewMode,
  root: string
): Promise<void> {
  const file = loadedFiles()[filePath];
  if (!file) return;
  const updated = await resolveModeFile(file, mode, root);
  loadedFiles.set({ ...loadedFiles(), [filePath]: updated });
}

async function saveFileInMap(
  loadedFiles: Signal<Record<string, LoadedFile>>,
  filePath: string,
  root: string,
  refresh: () => Promise<void>
): Promise<void> {
  const file = loadedFiles()[filePath];
  if (!file) return;
  const updated = await saveFileText(file, file.text, root);
  loadedFiles.set({ ...loadedFiles(), [filePath]: updated });
  await refresh();
}

function createAppActions(opts: {
  sidebarOpen: Signal<boolean>;
  terminalOpen: Signal<boolean>;
  openFolder: () => void;
  commandMode: Signal<"files" | "commands">;
  commandOpen: Signal<boolean>;
  fontDialogOpen: Signal<boolean>;
  adjustFontSize: (delta: number) => void;
  resetFont: () => void;
  cycleTheme: () => void;
  activeFilePath: () => string | null;
  saveFile: (p: string) => void;
  closeTab: (p: string) => void;
  refresh: () => void;
  setFileMode: (p: string, m: PreviewMode) => void;
}): AppActions {
  const withCurrent = (fn: (p: string) => void) => () => {
    const cur = opts.activeFilePath();
    if (cur) fn(cur);
  };
  return {
    toggleSidebar: () => opts.sidebarOpen.update((v) => !v),
    toggleTerminal: () => opts.terminalOpen.update((v) => !v),
    openFolder: opts.openFolder,
    openQuickOpen: () => {
      opts.commandMode.set("files");
      opts.commandOpen.set(true);
    },
    openCommandPalette: () => {
      opts.commandMode.set("commands");
      opts.commandOpen.set(true);
    },
    openFontSettings: () => opts.fontDialogOpen.set(true),
    adjustFontSize: opts.adjustFontSize,
    resetFont: opts.resetFont,
    saveCurrent: withCurrent(opts.saveFile),
    closeCurrent: withCurrent((p) => opts.closeTab(p)),
    toggleTheme: opts.cycleTheme,
    refresh: opts.refresh,
    setMode: (mode) => withCurrent((p) => opts.setFileMode(p, mode))(),
  };
}

function recordRecentWorkspace(
  recentWorkspaces: Signal<string[]>,
  folderPath: string
): void {
  if (!folderPath || folderPath === "/") return;
  const next = [
    folderPath,
    ...recentWorkspaces().filter((w) => w !== folderPath),
  ].slice(0, 5);
  recentWorkspaces.set(next);
  Storage.setItem("aed.recentWorkspaces", JSON.stringify(next));
}

function parseRecentWorkspaces(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function resolveSavedFontSize(
  savedSize: string | null,
  ghosttySize?: number
): number | null {
  const parsed = savedSize ? Number.parseInt(savedSize, 10) : Number.NaN;
  if (!Number.isNaN(parsed) && parsed >= 9 && parsed <= 28) return parsed;
  return ghosttySize ? Math.round(ghosttySize) : null;
}

async function getStorageWithFallback(name: string): Promise<string | null> {
  const primary = await Storage.getItem(`aed.${name}`);
  if (primary !== null) return primary;
  return Storage.getItem(`native-editor.${name}`);
}

function applySavedThemeAndFont(
  fontFamily: Signal<string>,
  fontSize: Signal<number>,
  themeId: Signal<string>,
  savedFamily: string | null,
  savedSize: string | null,
  savedTheme: string | null,
  ghostty: { fontFamily?: string; fontSize?: number; theme?: string }
): void {
  const family = savedFamily || ghostty.fontFamily;
  if (family) fontFamily.set(family);

  const size = resolveSavedFontSize(savedSize, ghostty.fontSize);
  if (size) fontSize.set(size);

  const resolvedTheme = getThemeById(savedTheme || ghostty.theme || DEFAULT_THEME_ID);
  themeId.set(resolvedTheme.id);
  setColorScheme(resolvedTheme.appearance);
}

async function initUserPreferences(
  fontFamily: Signal<string>,
  fontSize: Signal<number>,
  themeId: Signal<string>,
  defaultShell: Signal<string>,
  availableShells: Signal<ShellProfile[]>,
  recentWorkspaces: Signal<string[]>,
  onRestoreRecentWorkspace?: (folderPath: string) => Promise<void>
): Promise<void> {
  const [savedFamily, savedSize, savedTheme, savedShell, savedRecent, env] =
    await Promise.all([
      getStorageWithFallback("fontFamily"),
      getStorageWithFallback("fontSize"),
      getStorageWithFallback("theme"),
      getStorageWithFallback("shell"),
      getStorageWithFallback("recentWorkspaces"),
      discoverTerminalEnvironment(),
    ]);
  applySavedThemeAndFont(
    fontFamily,
    fontSize,
    themeId,
    savedFamily,
    savedSize,
    savedTheme,
    env.ghostty
  );

  if (env.shells.length > 0) availableShells.set(env.shells);
  const shell = savedShell || env.shells[0]?.path;
  if (shell) defaultShell.set(shell);

  const recent = parseRecentWorkspaces(savedRecent);
  recentWorkspaces.set(recent);
  if (recent.length > 0 && onRestoreRecentWorkspace) {
    await onRestoreRecentWorkspace(recent[0]);
  }
}

function App(): JSX.Element {
  const workspaceRoot = signal<string>(getInitialWorkspaceRoot());
  const recentWorkspaces = signal<string[]>([]);
  const snapshot = signal<WorkspaceSnapshot>({
    root: "",
    branch: "",
    entries: [],
    flatFiles: [],
    gitStatusMap: {},
    treeItemsAll: [],
    treeItemsChanged: [],
    commandItems: [],
  });

  const filterMode = signal<"all" | "changed">("all");
  const expandedIds = signal<string[]>([]);
  const selectedPath = signal<string | null>(null);
  const loadedFiles = signal<Record<string, LoadedFile>>({});
  const openTabs = signal<string[]>([]);
  const activeFilePath = signal<string | null>(null);

  const sidebarOpen = signal<boolean>(true);
  const sidebarWidth = signal<number>(240);
  const terminalOpen = signal<boolean>(false);
  const terminalHeight = signal<number>(224);

  const cursorLine = signal<number>(1);
  const cursorCol = signal<number>(1);
  const commandOpen = signal<boolean>(false);
  const commandMode = signal<"files" | "commands">("files");

  const fontFamily = signal<string>(DEFAULT_FONT_FAMILY);
  const fontSize = signal<number>(DEFAULT_FONT_SIZE);
  const themeId = signal<string>(DEFAULT_THEME_ID);
  const activeTheme = computed(() => getThemeById(themeId()));
  const defaultShell = signal<string>("/bin/zsh");
  const availableShells = signal<ShellProfile[]>([
    { name: "zsh", path: "/bin/zsh" },
    { name: "bash", path: "/bin/bash" },
    { name: "sh", path: "/bin/sh" },
  ]);
  const fontDialogOpen = signal<boolean>(false);

  const setFontFamily = (next: string) => {
    fontFamily.set(next);
    Storage.setItem("aed.fontFamily", next);
  };
  const adjustFontSize = (delta: number) => {
    const clamped = Math.max(9, Math.min(28, fontSize() + delta));
    fontSize.set(clamped);
    Storage.setItem("aed.fontSize", String(clamped));
  };
  const selectTheme = (nextId: string) => {
    const resolved = getThemeById(nextId);
    themeId.set(resolved.id);
    setColorScheme(resolved.appearance);
    Storage.setItem("aed.theme", resolved.id);
  };
  const cycleTheme = () => {
    const idx = EDITOR_THEMES.findIndex((t) => t.id === themeId());
    const next = EDITOR_THEMES[(idx + 1) % EDITOR_THEMES.length];
    selectTheme(next.id);
  };
  const setShellPath = (next: string) => {
    defaultShell.set(next);
    Storage.setItem("aed.shell", next);
  };
  const resetFont = () => {
    setFontFamily(DEFAULT_FONT_FAMILY);
    fontSize.set(DEFAULT_FONT_SIZE);
    Storage.setItem("aed.fontSize", String(DEFAULT_FONT_SIZE));
  };

  const refresh = async () => {
    snapshot.set(await scanWorkspace(workspaceRoot()));
  };

  const switchToWorkspace = async (folderPath: string) => {
    if (!folderPath) return;
    workspaceRoot.set(folderPath);
    recordRecentWorkspace(recentWorkspaces, folderPath);
    openTabs.set([]);
    activeFilePath.set(null);
    await refresh();
  };

  const openExternalFile = async (filePath: string) => {
    const cleanRoot = workspaceRoot().replace(/\/+$/, "");
    if (!cleanRoot || !filePath.startsWith(`${cleanRoot}/`)) {
      const parentDir = path.dirname(filePath);
      workspaceRoot.set(parentDir);
      recordRecentWorkspace(recentWorkspaces, parentDir);
      await refresh();
    }
    await openFileInTab(filePath);
    if (desktopAvailable) Window.orderFront();
  };

  effect(() => {
    refresh().then(async () => {
      if (workspaceRoot()) {
        recordRecentWorkspace(recentWorkspaces, workspaceRoot());
      }
      const initFile = getInitialOpenFile();
      if (initFile) await openExternalFile(initFile);
      const queued = await consumeFinderOpenQueue();
      for (const f of queued) {
        await openExternalFile(f);
      }
    });
    initUserPreferences(
      fontFamily,
      fontSize,
      themeId,
      defaultShell,
      availableShells,
      recentWorkspaces,
      async (lastFolder) => {
        if (!workspaceRoot() && !getInitialOpenFile()) {
          const scanned = await scanWorkspace(lastFolder);
          if (scanned.entries.length > 0) {
            workspaceRoot.set(lastFolder);
            snapshot.set(scanned);
          }
        }
      }
    );
    const timer = setInterval(async () => {
      const queued = await consumeFinderOpenQueue();
      for (const f of queued) {
        await openExternalFile(f);
      }
    }, 450);
    cleanup(() => clearInterval(timer));
  });

  const openFileInTab = async (filePath: string, openInDiff?: boolean) => {
    const current = loadedFiles();
    const file = await fetchOrReuseLoadedFile(
      current,
      filePath,
      workspaceRoot(),
      snapshot().gitStatusMap,
      openInDiff
    );
    loadedFiles.set({ ...current, [filePath]: file });
    if (!openTabs().includes(filePath)) {
      openTabs.update((tabs) => [...tabs, filePath]);
    }
    activeFilePath.set(filePath);
    selectedPath.set(filePath);
  };

  const closeTab = (filePath: string) => {
    const nextTabs = openTabs().filter((p) => p !== filePath);
    openTabs.set(nextTabs);
    if (activeFilePath() === filePath) {
      activeFilePath.set(nextTabs.length > 0 ? nextTabs[nextTabs.length - 1] : null);
    }
  };

  const handleOpenFolder = async () => {
    const chosen = await pickWorkspaceFolder(workspaceRoot());
    if (!chosen) return;
    await switchToWorkspace(chosen);
  };

  const handleSave = (filePath: string) =>
    saveFileInMap(loadedFiles, filePath, workspaceRoot(), refresh);
  const handleTextChange = (filePath: string, newText: string) =>
    updateFileTextInMap(loadedFiles, filePath, newText);
  const handleModeChange = (filePath: string, mode: PreviewMode) =>
    updateFileModeInMap(loadedFiles, filePath, mode, workspaceRoot());
  const handleOpenRelativeLink = (relUrl: string, baseFilePath: string) => {
    const resolved = resolveRelativeLink(relUrl, baseFilePath);
    if (resolved) openFileInTab(resolved);
  };

  const actions = createAppActions({
    sidebarOpen,
    terminalOpen,
    openFolder: handleOpenFolder,
    commandMode,
    commandOpen,
    fontDialogOpen,
    adjustFontSize,
    resetFont,
    cycleTheme,
    activeFilePath: () => activeFilePath(),
    saveFile: handleSave,
    closeTab,
    refresh,
    setFileMode: handleModeChange,
  });

  setupDesktopChrome(actions);
  cleanup(bindAppShortcuts(actions));

  const leftPad = computed(() =>
    Math.max(12, desktopAvailable ? titleBar().left : 12)
  );
  const activeFile = computed(() => {
    const p = activeFilePath();
    return p ? loadedFiles()[p] : undefined;
  });

  const changedCount = computed(() => Object.keys(snapshot().gitStatusMap).length);
  const treeItems = computed(() =>
    filterMode() === "all" ? snapshot().treeItemsAll : snapshot().treeItemsChanged
  );

  return (
    <View
      testID="app-root"
      class="flex-1 flex-col overflow-hidden"
      style={{
        backgroundColor: activeTheme().ui.background,
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
      }}
      onLayout={({ bounds }) =>
        enforceMinWindowSize(bounds.size.width, bounds.size.height)
      }
      onFileDrop={({ uris }) => {
        const p = decodeDroppedUri(uris[0]);
        if (p) openExternalFile(p);
      }}
    >
      <WindowTitleBar
        leftPad={leftPad}
        root={workspaceRoot}
        theme={activeTheme}
        sidebarOpen={sidebarOpen}
        terminalOpen={terminalOpen}
        onQuickOpen={actions.openQuickOpen}
        onOpenFolder={handleOpenFolder}
        onToggleSidebar={actions.toggleSidebar}
        onToggleTerminal={actions.toggleTerminal}
      />

      <View
        testID="main-dock"
        class="flex-1 min-h-0 overflow-hidden"
        style={{ backgroundColor: activeTheme().ui.background }}
      >
        <ResizablePanelGroup
          axis="horizontal"
          class="flex-1 min-h-0 overflow-hidden"
          style={{ backgroundColor: activeTheme().ui.background }}
          handleClass="bg-transparent hover:bg-primary/70 active:bg-primary transition-colors"
        >
          <ResizablePanel
            visible={sidebarOpen() && workspaceRoot().length > 0}
            fixed
            size={sidebarWidth()}
            minSize={180}
            maxSize={420}
            onResize={({ size }) => sidebarWidth.set(Math.round(size))}
            style={{ backgroundColor: activeTheme().ui.sidebar }}
            class="flex-col overflow-hidden"
          >
            <Sidebar
              root={workspaceRoot}
              filterMode={filterMode}
              treeItems={treeItems}
              expandedIds={expandedIds}
              selectedPath={selectedPath}
              gitStatusMap={() => snapshot().gitStatusMap}
              theme={activeTheme}
              onSelectFile={openFileInTab}
              onOpenFolder={handleOpenFolder}
            />
          </ResizablePanel>

          <ResizablePanel
            minSize={520}
            style={{ backgroundColor: activeTheme().ui.background }}
            class="flex-1 flex-col min-w-0 overflow-hidden"
          >
            <ResizablePanelGroup
              axis="vertical"
              class="flex-1 min-h-0 overflow-hidden"
              style={{ backgroundColor: activeTheme().ui.background }}
              handleClass="bg-transparent hover:bg-primary/70 active:bg-primary transition-colors"
            >
              <ResizablePanel
                minSize={260}
                style={{ backgroundColor: activeTheme().ui.background }}
                class="flex-1 flex-col min-h-0 overflow-hidden"
              >
                <EditorHeader
                  tabs={openTabs}
                  activePath={activeFilePath}
                  loadedFiles={loadedFiles}
                  activeFile={activeFile}
                  theme={activeTheme}
                  onSelectTab={(p) => {
                    activeFilePath.set(p);
                    selectedPath.set(p);
                  }}
                  onCloseTab={closeTab}
                  onModeChange={(m) => {
                    const cur = activeFilePath();
                    if (cur) handleModeChange(cur, m);
                  }}
                />

                <View
                  class="flex-1 min-h-0 overflow-hidden"
                  style={{ backgroundColor: activeTheme().ui.background }}
                >
                  <If when={activeFile() !== undefined}>
                    <PreviewPane
                      file={activeFile}
                      workspaceRoot={workspaceRoot}
                      fontFamily={fontFamily}
                      fontSize={fontSize}
                      theme={activeTheme}
                      onTextChange={handleTextChange}
                      onSave={handleSave}
                      onModeChange={handleModeChange}
                      onOpenRelativeLink={handleOpenRelativeLink}
                      onCursorChange={(line, col) => {
                        cursorLine.set(line + 1);
                        cursorCol.set(col + 1);
                      }}
                    />
                  </If>
                  <If when={activeFile() === undefined && workspaceRoot().length === 0}>
                    <WelcomePanel
                      recentWorkspaces={recentWorkspaces}
                      theme={activeTheme}
                      onOpenFolder={handleOpenFolder}
                      onSelectRecentWorkspace={switchToWorkspace}
                    />
                  </If>
                  <If when={activeFile() === undefined && workspaceRoot().length > 0}>
                    <EmptyEditorPanel
                      theme={activeTheme}
                      onQuickOpen={actions.openQuickOpen}
                      onOpenFolder={handleOpenFolder}
                      onToggleTerminal={actions.toggleTerminal}
                    />
                  </If>
                </View>
              </ResizablePanel>

              <ResizablePanel
                visible={terminalOpen()}
                fixed
                size={terminalHeight()}
                minSize={120}
                maxSize={360}
                onResize={({ size }) => terminalHeight.set(Math.round(size))}
                style={{ backgroundColor: activeTheme().ui.sidebar }}
                class="flex-col overflow-hidden"
              >
                <TerminalPane
                  cwd={workspaceRoot}
                  fontFamily={fontFamily}
                  fontSize={fontSize}
                  shellPath={defaultShell}
                  theme={activeTheme}
                  onShellChange={setShellPath}
                  onFileOpen={openFileInTab}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </View>

      <StatusBar
        root={workspaceRoot}
        branch={() => snapshot().branch}
        changedCount={changedCount}
        activeFile={activeFile}
        line={cursorLine}
        col={cursorCol}
        fontFamily={fontFamily}
        fontSize={fontSize}
        theme={activeTheme}
        onSelectTheme={selectTheme}
        onSelectFont={setFontFamily}
        onRefresh={refresh}
        onToggleTheme={actions.toggleTheme}
      />

      <FontSettingsDialog
        open={fontDialogOpen}
        fontFamily={fontFamily}
        fontSize={fontSize}
        themeId={themeId}
        theme={activeTheme}
        defaultShell={defaultShell}
        shells={availableShells}
        onSetTheme={selectTheme}
        onSetFamily={setFontFamily}
        onAdjustSize={adjustFontSize}
        onSetShell={setShellPath}
        onReset={resetFont}
      />

      <CommandPalette
        open={commandOpen}
        mode={commandMode}
        root={workspaceRoot}
        fileItems={() => snapshot().commandItems}
        commandItems={() => builtInCommands}
        theme={activeTheme}
        onSelectFile={(p) => openFileInTab(p)}
        onRunCommand={(cmdId) => COMMAND_HANDLERS[cmdId]?.(actions)}
      />
    </View>
  );
}

mount(App);
export default App;
