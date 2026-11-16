import {
  computed,
  effect,
  signal,
  Text,
  View,
  type Accessor,
  type JSX,
  type Signal,
} from "nsh";
import {
  Command,
  Tree,
  type CommandEntry,
  type CommandGroup,
  type CommandItem,
  type TreeEntry,
  type TreeItem,
} from "nsh/base";
import { FileBadge, Icon } from "./icons";
import { EDITOR_THEMES, type EditorTheme } from "./themes";
import { Keycap, ModalShell, SegmentedControl, type SegmentedItem } from "./ui";
import { lookupGitStatus, type GitStatusCode } from "./workspace";

export interface SidebarProps {
  root: Accessor<string>;
  branch?: Accessor<string>;
  filterMode: Signal<"all" | "changed">;
  treeItems: Accessor<TreeItem[]>;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  gitStatusMap: Accessor<Record<string, GitStatusCode>>;
  /** Why the folder cannot be listed (moved, deleted, unreadable): shown instead of the tree. */
  notice: Accessor<string | null>;
  theme?: Accessor<EditorTheme>;
  onSelectFile: (filePath: string, openInDiff?: boolean) => void;
}

export interface CommandPaletteProps {
  open: Signal<boolean>;
  mode: Accessor<"files" | "commands">;
  root: Accessor<string>;
  fileItems: Accessor<CommandItem[]>;
  commandItems: Accessor<CommandItem[]>;
  theme?: Accessor<EditorTheme>;
  onSelectFile: (filePath: string) => void;
  onRunCommand: (commandId: string) => void;
}

const GIT_STATUS_LIGHT: Partial<Record<GitStatusCode, string>> = {
  M: "#b45309",
  A: "#16a34a",
  U: "#16a34a",
  D: "#dc2626",
};

const GIT_STATUS_DARK: Partial<Record<GitStatusCode, string>> = {
  M: "#e0a96d",
  A: "#4cc38a",
  U: "#4cc38a",
  D: "#e5484d",
};

const SIDEBAR_FILTER_ITEMS: readonly SegmentedItem<"all" | "changed">[] = [
  {
    value: "all",
    label: "All",
    accessibilityLabel: "Show all files",
    testID: "sidebar-filter-all",
  },
  {
    value: "changed",
    label: "Changed",
    icon: "diff",
    accessibilityLabel: "Show changed files",
    testID: "sidebar-filter-changed",
  },
];

function getGitStatusColor(
  status: GitStatusCode | undefined,
  theme: EditorTheme,
): string {
  if (!status) return theme.ui.mutedForeground;
  const palette = theme.appearance === "light" ? GIT_STATUS_LIGHT : GIT_STATUS_DARK;
  return palette[status] ?? theme.ui.mutedForeground;
}

function collectFolderIds(items: TreeItem[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.children !== undefined) {
      out.add(item.id);
      collectFolderIds(item.children, out);
    }
  }
  return out;
}

export function resolveWorkspaceFolderName(root: string): string {
  const parts = root.split("/").filter(Boolean);
  return parts[parts.length - 1] || "workspace";
}

export function resolveChangedEmptyMessage(branch: string | undefined): string {
  if (branch === undefined) return "No uncommitted changes";
  return branch.length > 0 ? "No uncommitted changes" : "Not a Git repository";
}

export interface TreeRowContext {
  statusMap: Accessor<Record<string, GitStatusCode>>;
  expandedSet: Accessor<ReadonlySet<string>>;
  selectedPath: Accessor<string | null>;
  isChanged: Accessor<boolean>;
  root: Accessor<string>;
  theme: Accessor<EditorTheme>;
}

function renderDisabledTreeRow(
  entry: TreeEntry,
  theme: Accessor<EditorTheme>,
): JSX.Element {
  return (
    <View
      class="flex-row items-center h-7 pr-2 select-none"
      style={{ paddingLeft: entry.depth * 12 + 8 }}
    >
      <Text
        style={{ color: theme().ui.mutedForeground }}
        class="truncate text-xs italic flex-1"
      >
        {entry.label}
      </Text>
    </View>
  );
}

export function treeChevronRotation(expanded: boolean): "90deg" | "0deg" {
  return expanded ? "90deg" : "0deg";
}

export function treeRowTextOverflow(
  isChanged: boolean,
): "ellipsis-middle" | "ellipsis" {
  return isChanged ? "ellipsis-middle" : "ellipsis";
}

function TreeRowLeading(props: {
  folder: boolean;
  label: string;
  isExpanded: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  if (props.folder) {
    return (
      <View
        style={{ rotate: treeChevronRotation(props.isExpanded()) }}
        class="w-5 items-center justify-center shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none"
      >
        <Icon
          name="chevron-right"
          size={12}
          tint={() => props.theme().ui.mutedForeground}
        />
      </View>
    );
  }
  return (
    <FileBadge
      name={props.label}
      color={() => props.theme().ui.mutedForeground}
    />
  );
}

export function renderTreeRow(entry: TreeEntry, ctx: TreeRowContext): JSX.Element {
  if (entry.disabled) return renderDisabledTreeRow(entry, ctx.theme);

  const status = computed(() =>
    entry.folder ? undefined : lookupGitStatus(entry.id, ctx.root(), ctx.statusMap()),
  );
  const isExpanded = computed(() => entry.folder && ctx.expandedSet().has(entry.id));
  const isSelected = computed(() => ctx.selectedPath() === entry.id);

  return (
    <View
      class="flex-row items-center h-7 pr-2 rounded select-none gap-2"
      style={{
        paddingLeft: entry.depth * 12 + 8,
        backgroundColor: isSelected() ? ctx.theme().ui.background : "transparent",
      }}
    >
      <TreeRowLeading
        folder={entry.folder}
        label={entry.label}
        isExpanded={isExpanded}
        theme={ctx.theme}
      />
      <Text
        style={{
          color: ctx.theme().ui.foreground,
          numberOfLines: 1,
          textOverflow: treeRowTextOverflow(ctx.isChanged()),
        }}
        class={`truncate text-xs flex-1 ${
          isSelected() ? "font-medium" : "font-normal"
        }`}
      >
        {entry.label}
      </Text>
      <If when={status()}>
        {(code) => (
          <Text
            style={{ color: getGitStatusColor(code(), ctx.theme()) }}
            class="text-[11px] font-mono font-medium ml-1"
          >
            {code()}
          </Text>
        )}
      </If>
    </View>
  );
}

const TreeView = Tree as unknown as (
  props: import("nsh/base").TreeProps & { rowHeight?: number },
) => JSX.Element;

function SidebarHeader(props: {
  folderName: Accessor<string>;
  filterMode: Signal<"all" | "changed">;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <View
      testID="sidebar-header"
      style={{
        borderBottomWidth: 1,
        borderBottomColor: props.theme().ui.border,
      }}
      class="h-9 px-3 flex-row items-center justify-between gap-2 shrink-0"
    >
      <View
        testID="sidebar-workspace-title"
        class="flex-1 min-w-0 flex-row items-center pr-1"
      >
        <Text
          style={{ color: props.theme().ui.foreground }}
          class="text-xs font-medium truncate"
        >
          {props.folderName()}
        </Text>
      </View>

      <SegmentedControl
        items={SIDEBAR_FILTER_ITEMS}
        value={props.filterMode()}
        onChange={(mode) => props.filterMode.set(mode)}
        class="border border-border"
      />
    </View>
  );
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const theme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);
  const folderName = computed(() => resolveWorkspaceFolderName(props.root()));
  const isChanged = computed(() => props.filterMode() === "changed");
  const expandedSet = computed(() => new Set(props.expandedIds()));
  const folderIds = computed(() => collectFolderIds(props.treeItems()));
  const showChangedEmpty = computed(
    () => !props.notice() && isChanged() && props.treeItems().length === 0,
  );
  const changedEmptyMessage = computed(() =>
    resolveChangedEmptyMessage(props.branch?.()),
  );
  const rowCtx: TreeRowContext = {
    statusMap: props.gitStatusMap,
    expandedSet,
    selectedPath: props.selectedPath,
    isChanged,
    root: props.root,
    theme,
  };

  return (
    <View
      style={{ backgroundColor: theme().ui.sidebar }}
      class="flex-1 select-none overflow-hidden"
    >
      <SidebarHeader
        folderName={folderName}
        filterMode={props.filterMode}
        theme={theme}
      />

      <If when={props.notice()}>
        {(notice) => (
          <View testID="workspace-notice" class="px-5 py-3">
            <Text style={{ color: theme().ui.mutedForeground }} class="text-xs">
              {notice()}
            </Text>
          </View>
        )}
      </If>

      <If
        when={showChangedEmpty()}
        else={
          <TreeView
            testID="workspace-tree"
            rowHeight={28}
            itemClass="h-7"
            items={props.treeItems()}
            expanded={props.expandedIds()}
            selected={props.selectedPath()}
            onExpandedChange={({ expanded }) => props.expandedIds.set(expanded)}
            onSelectedChange={({ selected }) => {
              props.selectedPath.set(selected);
              if (!folderIds().has(selected)) {
                props.onSelectFile(selected, isChanged());
              }
            }}
            renderItem={(entry: TreeEntry) => renderTreeRow(entry, rowCtx)}
            class="flex-1 px-2 py-1"
          />
        }
      >
        <View
          testID="sidebar-changed-empty"
          class="flex-1 px-4 items-center justify-center"
        >
          <Text
            style={{ color: theme().ui.mutedForeground }}
            class="text-xs text-center"
          >
            {changedEmptyMessage()}
          </Text>
        </View>
      </If>
    </View>
  );
}

function CommandGroupHeading(props: {
  group: CommandGroup;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <Text
      style={{ color: props.theme().ui.mutedForeground }}
      class="text-xs font-medium"
    >
      {props.group.heading}
    </Text>
  );
}

function CommandItemRow(props: {
  entry: CommandEntry;
  highlightedId: Accessor<string | null>;
  showFileBadge: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  const isHighlighted = computed(() => props.highlightedId() === props.entry.id);
  const shortcut = props.entry.shortcut || props.entry.shortcutLabel || "";
  return (
    <View
      style={{
        backgroundColor: isHighlighted()
          ? props.theme().ui.selection
          : "transparent",
      }}
      hoverStyle={{
        backgroundColor: isHighlighted()
          ? props.theme().ui.selection
          : props.theme().ui.sidebar,
      }}
      class="h-8 px-3 rounded flex-row items-center justify-between gap-2 select-none"
    >
      <View class="flex-row items-center gap-2 flex-1 min-w-0">
        <If when={props.showFileBadge()}>
          <FileBadge
            name={props.entry.label}
            color={() => props.theme().ui.mutedForeground}
          />
        </If>
        <Text
          style={{ color: props.theme().ui.foreground }}
          class="text-xs truncate flex-1"
        >
          {props.entry.label}
        </Text>
      </View>
      <If when={shortcut.length > 0}>
        <Keycap shortcut={shortcut} />
      </If>
    </View>
  );
}

function resolveCommandPlaceholder(isFiles: boolean, root: string): string {
  if (!isFiles) return "Run a command";
  if (!root) return "Switch recent workspace";
  return `Search ${resolveWorkspaceFolderName(root)}`;
}

function dispatchCommandSelection(
  id: string,
  isFiles: boolean,
  props: CommandPaletteProps,
): void {
  props.open.set(false);
  if (isFiles) props.onSelectFile(id);
  else props.onRunCommand(id);
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const query = signal("");
  const highlightedId = signal<string | null>(null);
  const theme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);

  const isFiles = computed(() => props.mode() === "files");
  const showFileBadge = computed(() => isFiles() && props.root().length > 0);
  const items = computed(() =>
    isFiles() ? props.fileItems() : props.commandItems(),
  );
  const placeholder = computed(() =>
    resolveCommandPlaceholder(isFiles(), props.root()),
  );

  effect(() => {
    if (props.open()) {
      query.set("");
      highlightedId.set(items()[0]?.id ?? null);
    }
  });

  return (
    <ModalShell open={props.open} widthClass="w-[520px]" topOffsetClass="pt-12">
      <Command
        testID="command-palette"
        items={items()}
        query={query()}
        onQueryChange={({ query: q }) => query.set(q)}
        onHighlightChange={({ highlighted }) => highlightedId.set(highlighted)}
        onSelect={({ id }) => dispatchCommandSelection(id, isFiles(), props)}
        onCancel={() => props.open.set(false)}
        autoFocus
        placeholder={placeholder()}
        searchPrefix={
          <Icon
            name="search"
            size={14}
            tint={() => theme().ui.mutedForeground}
          />
        }
        style={{ backgroundColor: theme().ui.card }}
        class="w-full"
        searchBarClass="h-9 px-3 rounded border flex-row items-center gap-2"
        searchBarStyle={{
          backgroundColor: theme().ui.background,
          borderColor: theme().ui.border,
        }}
        searchClass="flex-1 h-8 text-xs"
        searchStyle={{
          height: 32,
          color: theme().ui.foreground,
          placeholderColor: theme().ui.mutedForeground,
        }}
        listClass="pt-2 max-h-80"
        groupClass="px-2 pt-2 pb-1"
        separatorClass="my-1 h-px bg-transparent"
        itemClass="group rounded active:opacity-80"
        renderGroup={(group) => (
          <CommandGroupHeading group={group} theme={theme} />
        )}
        renderItem={(entry) => (
          <CommandItemRow
            entry={entry}
            highlightedId={highlightedId}
            showFileBadge={showFileBadge}
            theme={theme}
          />
        )}
        empty={
          <View class="py-6 items-center">
            <Text
              style={{ color: theme().ui.mutedForeground }}
              class="text-xs"
            >
              No matching results
            </Text>
          </View>
        }
      />
    </ModalShell>
  );
}
