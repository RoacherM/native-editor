import path from "path";
import {
  cleanup,
  colorScheme,
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
  type CommandItem,
} from "nsh/base";
import {
  isAvailable as desktopAvailable,
  Menu as DesktopMenu,
  titleBar,
  Window,
} from "nsh/desktop";
import type { PreviewMode } from "./src/classify";
import { FileBadge, Icon } from "./src/icons";
import { formatMediaMeta, PreviewPane } from "./src/PreviewPane";
import { CommandPalette, Sidebar } from "./src/Sidebar";
import {
  discoverTerminalEnvironment,
  TerminalPane,
  type ShellProfile,
} from "./src/TerminalPane";
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
  type GitStatusCode,
  type LoadedFile,
  type WorkspaceSnapshot,
} from "./src/workspace";

const DEFAULT_FONT_FAMILY = "JetBrainsMono Nerd Font Mono";
const DEFAULT_FONT_SIZE = 13;

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
  { id: "configure-font", label: "Preferences: Configure Font Family & Size...", keywords: ["font", "size", "family", "typography"] },
  { id: "font-size-inc", label: "View: Increase Font Size", shortcut: "mod+=", keywords: ["font", "zoom", "larger"] },
  { id: "font-size-dec", label: "View: Decrease Font Size", shortcut: "mod+-", keywords: ["font", "zoom", "smaller"] },
  { id: "toggle-sidebar", label: "View: Toggle Sidebar", shortcut: "mod+b", keywords: ["sidebar", "explorer"] },
  { id: "toggle-terminal", label: "View: Toggle Terminal", shortcut: "mod+j", keywords: ["terminal", "pty", "console"] },
  { id: "open-folder", label: "File: Open Folder...", shortcut: "mod+o", keywords: ["open", "folder", "workspace"] },
  { id: "save-file", label: "File: Save Current File", shortcut: "mod+s", keywords: ["save", "write"] },
  { id: "close-tab", label: "View: Close Current Tab", shortcut: "mod+w", keywords: ["close", "tab"] },
  { id: "toggle-theme", label: "Preferences: Toggle Light/Dark Theme", keywords: ["theme", "light", "dark"] },
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
      class={`h-[34px] px-2.5 flex-row items-center gap-1 border-r border-border shrink-0 select-none ${
        isActive()
          ? "bg-background text-foreground"
          : "bg-sidebar text-muted-foreground hover:text-foreground"
      }`}
    >
      <Button
        testID={`tab-select-${name()}`}
        onPress={props.onSelect}
        class="h-full px-0.5 flex-row items-center gap-1.5 bg-transparent border-none shadow-none"
      >
        <FileBadge name={name} />
        <Text
          class={`text-xs ${
            isActive()
              ? "text-foreground font-medium"
              : "text-muted-foreground"
          }`}
        >
          {name()}
        </Text>
        <If when={isDirty()}>
          <Text class="text-amber-500 font-bold text-xs leading-none">•</Text>
        </If>
      </Button>
      <Button
        testID={`tab-close-${name()}`}
        onPress={props.onClose}
        class="h-4 w-4 items-center justify-center rounded hover:bg-muted/60 bg-transparent border-none shadow-none p-0"
      >
        <Icon name="close" size={10} tint="#888888" />
      </Button>
    </View>
  );
}

function ModePillBtn(props: {
  id: string;
  label: string;
  mode: PreviewMode;
  currentMode: Accessor<PreviewMode>;
  onSelect: (mode: PreviewMode) => void;
}): JSX.Element {
  const active = computed(() => props.currentMode() === props.mode);
  return (
    <Button
      testID={props.id}
      selected={active()}
      onPress={() => props.onSelect(props.mode)}
      class={`h-5 px-2 rounded border-none shadow-none ${
        active()
          ? "bg-muted text-foreground"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      <Text
        class={`text-[11px] ${
          active() ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function WindowTitleBar(props: {
  leftPad: Accessor<number>;
  root: Accessor<string>;
  sidebarOpen: Accessor<boolean>;
  terminalOpen: Accessor<boolean>;
  onQuickOpen: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
}): JSX.Element {
  const folderName = computed(() => {
    const raw = props.root();
    const parts = raw.split("/").filter(Boolean);
    return parts[parts.length - 1] || "workspace";
  });

  return (
    <View
      desktop={{ windowDrag: true }}
      class="h-[30px] bg-sidebar border-b border-border flex-row items-center justify-between pr-2.5 shrink-0 select-none"
      style={{ paddingLeft: props.leftPad() }}
    >
      <View class="w-12 shrink-0" />
      <View class="flex-1 items-center justify-center min-w-0 px-4">
        <Button
          testID="titlebar-quick-open"
          onPress={props.onQuickOpen}
          class="w-[320px] max-w-full h-[22px] px-3 rounded-md bg-card/90 hover:bg-muted/70 border border-border flex-row items-center justify-center gap-1.5 shadow-none"
        >
          <Icon name="search" size={11.5} tint="#888888" />
          <Text class="text-[11.5px] text-muted-foreground truncate">
            {folderName()}
          </Text>
        </Button>
      </View>
      <View class="flex-row items-center gap-1 shrink-0">
        <Button
          testID="titlebar-toggle-sidebar"
          onPress={props.onToggleSidebar}
          class="h-6 w-6 items-center justify-center rounded bg-transparent hover:bg-muted/50 border-none shadow-none p-0"
        >
          <Icon
            name="sidebar"
            size={14}
            tint={props.sidebarOpen() ? "#cccccc" : "#7a7a7a"}
          />
        </Button>
        <Button
          testID="titlebar-toggle-terminal"
          onPress={props.onToggleTerminal}
          class="h-6 w-6 items-center justify-center rounded bg-transparent hover:bg-muted/50 border-none shadow-none p-0"
        >
          <Icon
            name="panel-bottom"
            size={14}
            tint={props.terminalOpen() ? "#cccccc" : "#7a7a7a"}
          />
        </Button>
      </View>
    </View>
  );
}

function EditorHeader(props: {
  tabs: Accessor<string[]>;
  activePath: Accessor<string | null>;
  loadedFiles: Accessor<Record<string, LoadedFile>>;
  activeFile: Accessor<LoadedFile | undefined>;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
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
    <View class="flex-col shrink-0 select-none bg-background">
      <If when={props.tabs().length > 0}>
        <View class="h-[34px] bg-sidebar border-b border-border flex-row items-center">
          <Scroll horizontal class="flex-1 shrink min-w-0">
            <View class="flex-row items-stretch h-[34px]">
              <Each of={props.tabs()} key={(path) => path}>
                {(tabPath) => (
                  <TabItem
                    path={tabPath}
                    activePath={props.activePath}
                    loadedFiles={props.loadedFiles}
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
        <View class="h-[26px] px-3 bg-background flex-row items-center justify-between">
          <View class="flex-row items-center gap-1 flex-1 min-w-0">
            <Each of={dirParts()} key={(seg, idx) => `${idx}-${seg}`}>
              {(seg) => (
                <View class="flex-row items-center gap-1 shrink-0">
                  <Text class="text-[11.5px] text-muted-foreground">{seg()}</Text>
                  <Icon name="chevron-right" size={10} tint="#6e6e6e" />
                </View>
              )}
            </Each>
            <FileBadge name={() => props.activeFile()?.name ?? ""} />
            <Text class="text-[11.5px] text-muted-foreground truncate">
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
                onSelect={props.onModeChange}
              />
              <ModePillBtn
                id="mode-source"
                label={rawLabel()}
                mode="source"
                currentMode={currentMode}
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
                onSelect={props.onModeChange}
              />
              <ModePillBtn
                id="mode-source"
                label="Code"
                mode="source"
                currentMode={currentMode}
                onSelect={props.onModeChange}
              />
            </View>
          </If>
        </View>
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
  const short = (family || "Mono").split(/\s+/)[0];
  return `${short} · ${size}px`;
}

function StatusBar(props: {
  branch: Accessor<string>;
  changedCount: Accessor<number>;
  activeFile: Accessor<LoadedFile | undefined>;
  line: Accessor<number>;
  col: Accessor<number>;
  fontFamily: Accessor<string>;
  fontSize: Accessor<number>;
  onOpenFontSettings: () => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
}): JSX.Element {
  const contextInfo = computed(() =>
    getContextAwareInfo(props.activeFile(), props.line(), props.col())
  );
  const fontBadge = computed(() =>
    shortFontLabel(props.fontFamily(), props.fontSize())
  );

  return (
    <View class="h-[22px] px-3 bg-sidebar border-t border-border select-none flex-row items-center justify-between shrink-0">
      <View class="flex-row items-center gap-2">
        <View class="flex-row items-center gap-1">
          <Icon name="branch" size={11} tint="#888888" />
          <Text class="text-[11px] text-muted-foreground font-mono">
            {props.branch() || "main"}
            {props.changedCount() > 0 ? "*" : ""}
          </Text>
        </View>
        <Button
          testID="sidebar-refresh"
          onPress={props.onRefresh}
          class="h-4 w-4 items-center justify-center rounded bg-transparent hover:bg-muted/50 border-none shadow-none p-0"
        >
          <Icon name="refresh" size={10.5} tint="#808080" />
        </Button>
      </View>

      <View class="flex-row items-center gap-2.5">
        <If when={!!contextInfo()}>
          <Text class="text-[11px] text-muted-foreground font-mono">
            {contextInfo()}
          </Text>
        </If>
        <Button
          testID="statusbar-font-btn"
          onPress={props.onOpenFontSettings}
          class="h-4 px-1.5 items-center justify-center rounded bg-transparent hover:bg-muted/60 border-none shadow-none p-0"
        >
          <Text class="text-[10.5px] font-mono text-muted-foreground hover:text-foreground">
            {fontBadge()}
          </Text>
        </Button>
        <Button
          testID="titlebar-toggle-theme"
          onPress={props.onToggleTheme}
          class="h-4 w-4 items-center justify-center rounded bg-transparent hover:bg-muted/50 border-none shadow-none p-0"
        >
          <Icon name="sun" size={11.5} tint="#828282" />
        </Button>
      </View>
    </View>
  );
}

function FontSettingsDialog(props: {
  open: Signal<boolean>;
  fontFamily: Signal<string>;
  fontSize: Signal<number>;
  defaultShell: Signal<string>;
  shells: Accessor<ShellProfile[]>;
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
          class="w-[460px] max-w-[92%] p-4 rounded-lg border border-border bg-popover shadow-xl gap-3.5 select-none"
        >
          <View class="flex-row items-center justify-between">
            <Text class="text-xs font-semibold text-foreground">
              Preferences: Font & Terminal
            </Text>
            <Button
              testID="font-dialog-close"
              onPress={() => props.open.set(false)}
              class="h-5 w-5 items-center justify-center rounded bg-transparent hover:bg-muted/60 border-none shadow-none p-0"
            >
              <Icon name="close" size={11} tint="#888888" />
            </Button>
          </View>

          <View class="gap-1.5">
            <Text class="text-[11px] text-muted-foreground">Font Family</Text>
            <Input
              testID="font-family-input"
              value={props.fontFamily()}
              onChange={({ value }) => props.onSetFamily(value)}
              placeholder="e.g. JetBrainsMono Nerd Font Mono, SF Mono, Menlo..."
              style={{ height: 28, fontFamily: props.fontFamily() || undefined }}
              class="w-full h-7 px-2.5 text-xs font-mono text-foreground bg-background rounded border border-border"
            />
            <View class="flex-row flex-wrap gap-1.5 pt-1">
              <Each of={FONT_FAMILY_PRESETS} key={(f) => f}>
                {(preset) => (
                  <Button
                    testID={`font-preset-${preset().split(/\s+/)[0]}`}
                    onPress={() => props.onSetFamily(preset())}
                    class={`h-6 px-2 rounded border shadow-none ${
                      props.fontFamily() === preset()
                        ? "bg-primary border-primary"
                        : "bg-secondary/70 hover:bg-secondary border-border"
                    }`}
                  >
                    <Text
                      style={{ fontFamily: preset() }}
                      class={`text-[10.5px] ${
                        props.fontFamily() === preset()
                          ? "text-primary-foreground font-medium"
                          : "text-secondary-foreground"
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
            <Text class="text-[11px] text-muted-foreground">Font Size</Text>
            <View class="flex-row items-center gap-1.5">
              <Button
                testID="font-size-dec"
                onPress={() => props.onAdjustSize(-1)}
                class="h-6 w-6 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border border-border shadow-none p-0"
              >
                <Text class="text-xs font-mono text-foreground">-</Text>
              </Button>
              <Text
                testID="font-size-value"
                class="w-12 text-center text-xs font-mono text-foreground"
              >
                {`${props.fontSize()}px`}
              </Text>
              <Button
                testID="font-size-inc"
                onPress={() => props.onAdjustSize(1)}
                class="h-6 w-6 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border border-border shadow-none p-0"
              >
                <Text class="text-xs font-mono text-foreground">+</Text>
              </Button>
              <Button
                testID="font-reset-btn"
                onPress={props.onReset}
                class="h-6 px-2.5 ml-1 items-center justify-center rounded bg-secondary hover:bg-secondary/80 border border-border shadow-none"
              >
                <Text class="text-[11px] text-secondary-foreground">Reset</Text>
              </Button>
            </View>
          </View>

          <View class="gap-1.5 pt-1">
            <Text class="text-[11px] text-muted-foreground">Terminal Shell</Text>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={props.shells()} key={(s) => s.path}>
                {(sh) => (
                  <Button
                    testID={`shell-preset-${sh().name}`}
                    onPress={() => props.onSetShell(sh().path)}
                    class={`h-6 px-2.5 rounded border shadow-none ${
                      props.defaultShell() === sh().path
                        ? "bg-primary border-primary"
                        : "bg-secondary/70 hover:bg-secondary border-border"
                    }`}
                  >
                    <Text
                      class={`text-[10.5px] font-mono ${
                        props.defaultShell() === sh().path
                          ? "text-primary-foreground font-medium"
                          : "text-secondary-foreground"
                      }`}
                    >
                      {`${sh().name} (${sh().path})`}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <View class="p-2.5 rounded bg-background border border-border">
            <Text
              style={{
                fontFamily: props.fontFamily() || undefined,
                fontSize: props.fontSize(),
              }}
              class="text-foreground font-mono"
            >
              {"const greeting = () => '0O1lI != === =>';"}
            </Text>
          </View>
        </View>
      </Dialog>
    </If>
  );
}

function WelcomePanel(props: {
  onOpenFolder: () => void;
  onQuickOpen: () => void;
}): JSX.Element {
  return (
    <View class="flex-1 items-center justify-center p-8 gap-4 bg-background select-none">
      <Text class="text-2xl font-bold text-foreground">Native Editor</Text>
      <Text class="text-sm text-muted-foreground max-w-md text-center">
        Lightweight native editor and multi-format previewer.
      </Text>
      <View class="flex-row gap-3 mt-4">
        <Button
          onPress={props.onOpenFolder}
          class="px-4 py-2 rounded bg-primary hover:bg-primary/90"
        >
          <Text class="text-xs text-primary-foreground font-medium">
            Open Folder
          </Text>
        </Button>
        <Button
          onPress={props.onQuickOpen}
          class="px-4 py-2 rounded bg-secondary hover:bg-secondary/80"
        >
          <Text class="text-xs text-secondary-foreground font-medium">
            Search Files
          </Text>
        </Button>
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

function setupDesktopChrome(actions: AppActions): void {
  if (!desktopAvailable) return;
  Window.setTitleBar({ style: "hidden" });
  Window.setTitle("Native Editor");
  Window.setFrame({ size: { width: 1280, height: 800 } });
  DesktopMenu.setApplicationMenu([
    {
      label: "Native Editor",
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
    toggleTheme: () => setColorScheme(colorScheme() === "dark" ? "light" : "dark"),
    refresh: opts.refresh,
    setMode: (mode) => withCurrent((p) => opts.setFileMode(p, mode))(),
  };
}

async function initFontSettings(
  fontFamily: Signal<string>,
  fontSize: Signal<number>,
  defaultShell: Signal<string>,
  availableShells: Signal<ShellProfile[]>
): Promise<void> {
  const [savedFamily, savedSize, savedShell, env] = await Promise.all([
    Storage.getItem("native-editor.fontFamily"),
    Storage.getItem("native-editor.fontSize"),
    Storage.getItem("native-editor.shell"),
    discoverTerminalEnvironment(),
  ]);
  if (savedFamily) fontFamily.set(savedFamily);
  else if (env.ghostty.fontFamily) fontFamily.set(env.ghostty.fontFamily);

  const parsedSize = savedSize ? Number.parseInt(savedSize, 10) : Number.NaN;
  if (!Number.isNaN(parsedSize) && parsedSize >= 9 && parsedSize <= 28) {
    fontSize.set(parsedSize);
  } else if (env.ghostty.fontSize) {
    fontSize.set(Math.round(env.ghostty.fontSize));
  }

  if (env.shells.length > 0) availableShells.set(env.shells);
  if (savedShell) defaultShell.set(savedShell);
  else if (env.shells[0]) defaultShell.set(env.shells[0].path);
}

function App(): JSX.Element {
  const workspaceRoot = signal<string>(getInitialWorkspaceRoot());
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
  const sidebarWidth = signal<number>(236);
  const terminalOpen = signal<boolean>(false);
  const terminalHeight = signal<number>(220);

  const cursorLine = signal<number>(1);
  const cursorCol = signal<number>(1);
  const commandOpen = signal<boolean>(false);
  const commandMode = signal<"files" | "commands">("files");

  const fontFamily = signal<string>(DEFAULT_FONT_FAMILY);
  const fontSize = signal<number>(DEFAULT_FONT_SIZE);
  const defaultShell = signal<string>("/bin/zsh");
  const availableShells = signal<ShellProfile[]>([
    { name: "zsh", path: "/bin/zsh" },
    { name: "bash", path: "/bin/bash" },
    { name: "sh", path: "/bin/sh" },
  ]);
  const fontDialogOpen = signal<boolean>(false);

  const setFontFamily = (next: string) => {
    fontFamily.set(next);
    Storage.setItem("native-editor.fontFamily", next);
  };
  const adjustFontSize = (delta: number) => {
    const clamped = Math.max(9, Math.min(28, fontSize() + delta));
    fontSize.set(clamped);
    Storage.setItem("native-editor.fontSize", String(clamped));
  };
  const setShellPath = (next: string) => {
    defaultShell.set(next);
    Storage.setItem("native-editor.shell", next);
  };
  const resetFont = () => {
    setFontFamily(DEFAULT_FONT_FAMILY);
    fontSize.set(DEFAULT_FONT_SIZE);
    Storage.setItem("native-editor.fontSize", String(DEFAULT_FONT_SIZE));
  };

  const refresh = async () => {
    snapshot.set(await scanWorkspace(workspaceRoot()));
  };

  const openExternalFile = async (filePath: string) => {
    const cleanRoot = workspaceRoot().replace(/\/+$/, "");
    if (!filePath.startsWith(`${cleanRoot}/`)) {
      workspaceRoot.set(path.dirname(filePath));
      await refresh();
    }
    await openFileInTab(filePath);
    if (desktopAvailable) Window.orderFront();
  };

  effect(() => {
    refresh().then(async () => {
      const initFile = getInitialOpenFile();
      if (initFile) await openExternalFile(initFile);
      const queued = await consumeFinderOpenQueue();
      for (const f of queued) {
        await openExternalFile(f);
      }
    });
    initFontSettings(fontFamily, fontSize, defaultShell, availableShells);
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
    workspaceRoot.set(chosen);
    openTabs.set([]);
    activeFilePath.set(null);
    await refresh();
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
      class="flex-1 flex-col bg-background overflow-hidden"
      onFileDrop={({ uris }) => {
        const p = decodeDroppedUri(uris[0]);
        if (p) openFileInTab(p);
      }}
    >
      <WindowTitleBar
        leftPad={leftPad}
        root={workspaceRoot}
        sidebarOpen={sidebarOpen}
        terminalOpen={terminalOpen}
        onQuickOpen={actions.openQuickOpen}
        onToggleSidebar={actions.toggleSidebar}
        onToggleTerminal={actions.toggleTerminal}
      />

      <View testID="main-dock" class="flex-1 min-h-0 overflow-hidden bg-background">
        <ResizablePanelGroup
          axis="horizontal"
          class="flex-1 min-h-0 overflow-hidden bg-background"
          handleClass="bg-border hover:bg-sky-500/60 active:bg-sky-400 transition-colors"
        >
          <ResizablePanel
            visible={sidebarOpen()}
            fixed
            size={sidebarWidth()}
            minSize={160}
            maxSize={480}
            onResize={({ size }) => sidebarWidth.set(Math.round(size))}
            class="bg-sidebar flex-col overflow-hidden"
          >
            <Sidebar
              root={workspaceRoot}
              filterMode={filterMode}
              treeItems={treeItems}
              expandedIds={expandedIds}
              selectedPath={selectedPath}
              gitStatusMap={() => snapshot().gitStatusMap}
              onSelectFile={openFileInTab}
              onOpenFolder={handleOpenFolder}
            />
          </ResizablePanel>

          <ResizablePanel
            minSize={320}
            class="flex-1 flex-col min-w-0 bg-background overflow-hidden"
          >
            <ResizablePanelGroup
              axis="vertical"
              class="flex-1 min-h-0 overflow-hidden bg-background"
              handleClass="bg-border hover:bg-sky-500/60 active:bg-sky-400 transition-colors"
            >
              <ResizablePanel
                minSize={140}
                class="flex-1 flex-col min-h-0 bg-background overflow-hidden"
              >
                <EditorHeader
                  tabs={openTabs}
                  activePath={activeFilePath}
                  loadedFiles={loadedFiles}
                  activeFile={activeFile}
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

                <View class="flex-1 min-h-0 bg-background overflow-hidden">
                  <If when={activeFile() !== undefined}>
                    <PreviewPane
                      file={activeFile}
                      workspaceRoot={workspaceRoot}
                      fontFamily={fontFamily}
                      fontSize={fontSize}
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
                  <If when={activeFile() === undefined}>
                    <WelcomePanel
                      onOpenFolder={handleOpenFolder}
                      onQuickOpen={actions.openQuickOpen}
                    />
                  </If>
                </View>
              </ResizablePanel>

              <ResizablePanel
                visible={terminalOpen()}
                fixed
                size={terminalHeight()}
                minSize={100}
                maxSize={560}
                onResize={({ size }) => terminalHeight.set(Math.round(size))}
                class="bg-sidebar flex-col overflow-hidden"
              >
                <TerminalPane
                  cwd={workspaceRoot}
                  fontFamily={fontFamily}
                  fontSize={fontSize}
                  shellPath={defaultShell}
                  onShellChange={setShellPath}
                  onFileOpen={openFileInTab}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </View>

      <StatusBar
        branch={() => snapshot().branch}
        changedCount={changedCount}
        activeFile={activeFile}
        line={cursorLine}
        col={cursorCol}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onOpenFontSettings={actions.openFontSettings}
        onRefresh={refresh}
        onToggleTheme={actions.toggleTheme}
      />

      <FontSettingsDialog
        open={fontDialogOpen}
        fontFamily={fontFamily}
        fontSize={fontSize}
        defaultShell={defaultShell}
        shells={availableShells}
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
        onSelectFile={(p) => openFileInTab(p)}
        onRunCommand={(cmdId) => COMMAND_HANDLERS[cmdId]?.(actions)}
      />
    </View>
  );
}

mount(App);
export default App;
