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
  Button,
  Command,
  Dialog,
  Tree,
  type CommandEntry,
  type CommandGroup,
  type CommandItem,
  type TreeEntry,
  type TreeItem,
} from "nsh/base";
import { FileBadge, Icon } from "./icons";
import { EDITOR_THEMES, type EditorTheme } from "./themes";
import { lookupGitStatus, type GitStatusCode } from "./workspace";

export interface SidebarProps {
  root: Accessor<string>;
  filterMode: Signal<"all" | "changed">;
  treeItems: Accessor<TreeItem[]>;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  gitStatusMap: Accessor<Record<string, GitStatusCode>>;
  theme?: Accessor<EditorTheme>;
  onSelectFile: (filePath: string, openInDiff?: boolean) => void;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
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

function getGitStatusColor(
  status: GitStatusCode | undefined,
  theme: EditorTheme
): string {
  const isLight = theme.appearance === "light";
  if (status === "M") return isLight ? "#b45309" : "#e0a96d";
  if (status === "A" || status === "U") return isLight ? "#16a34a" : "#4cc38a";
  if (status === "D") return isLight ? "#dc2626" : "#e5484d";
  return theme.ui.mutedForeground;
}

function isFolderItem(items: TreeItem[], id: string): boolean {
  for (const item of items) {
    if (item.id === id) return item.children !== undefined;
    if (item.children && isFolderItem(item.children, id)) return true;
  }
  return false;
}

function renderTreeRow(
  entry: TreeEntry,
  statusMap: Accessor<Record<string, GitStatusCode>>,
  expandedIds: Accessor<string[]>,
  selectedPath: Accessor<string | null>,
  root: Accessor<string>,
  theme: Accessor<EditorTheme>
): JSX.Element {
  const status = computed(() => lookupGitStatus(entry.id, root(), statusMap()));
  const isExpanded = computed(() => expandedIds().includes(entry.id));
  const isSelected = computed(() => selectedPath() === entry.id);
  return (
    <View
      class="flex-row items-center h-7 pr-2 rounded select-none gap-2"
      style={{
        paddingLeft: entry.depth * 12 + 8,
        backgroundColor: isSelected() ? theme().ui.background : "transparent",
      }}
    >
      <If when={entry.folder}>
        <View class="w-5 items-center justify-center shrink-0">
          <If when={isExpanded()}>
            <Icon
              name="chevron-down"
              size={12}
              tint={() => theme().ui.mutedForeground}
            />
          </If>
          <If when={!isExpanded()}>
            <Icon
              name="chevron-right"
              size={12}
              tint={() => theme().ui.mutedForeground}
            />
          </If>
        </View>
      </If>
      <If when={!entry.folder}>
        <FileBadge
          name={entry.label}
          color={() => theme().ui.mutedForeground}
        />
      </If>
      <Text
        style={{ color: theme().ui.foreground }}
        class={`truncate text-xs flex-1 ${
          isSelected() ? "font-medium" : "font-normal"
        }`}
      >
        {entry.label}
      </Text>
      <If when={!!status()}>
        <Text
          style={{ color: getGitStatusColor(status(), theme()) }}
          class="text-[11px] font-mono font-medium ml-1"
        >
          {status()}
        </Text>
      </If>
    </View>
  );
}

const TreeView = Tree as unknown as (
  props: import("nsh/base").TreeProps & { rowHeight?: number }
) => JSX.Element;

export function Sidebar(props: SidebarProps): JSX.Element {
  const theme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);
  const folderName = computed(() => {
    const raw = props.root();
    const parts = raw.split("/").filter(Boolean);
    return parts[parts.length - 1] || "workspace";
  });
  const isAll = computed(() => props.filterMode() === "all");
  const isChanged = computed(() => props.filterMode() === "changed");

  return (
    <View
      style={{ backgroundColor: theme().ui.sidebar }}
      class="flex-1 select-none overflow-hidden"
    >
      <View class="h-8 px-3 flex-row items-center justify-between shrink-0">
        <View
          testID="sidebar-workspace-title"
          class="flex-1 min-w-0 flex-row items-center pr-2"
        >
          <Text
            style={{ color: theme().ui.foreground }}
            class="text-xs font-medium truncate"
          >
            {folderName()}
          </Text>
        </View>

        <View class="flex-row items-center gap-1 shrink-0">
          <Button
            testID="sidebar-filter-all"
            selected={isAll()}
            onPress={() => props.filterMode.set("all")}
            style={{
              backgroundColor: isAll() ? theme().ui.background : "transparent",
            }}
            class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
          >
            <Icon
              name="files"
              size={14}
              tint={() =>
                isAll() ? theme().ui.foreground : theme().ui.mutedForeground
              }
            />
          </Button>

          <Button
            testID="sidebar-filter-changed"
            selected={isChanged()}
            onPress={() => props.filterMode.set("changed")}
            style={{
              backgroundColor: isChanged()
                ? theme().ui.background
                : "transparent",
            }}
            class="h-6 w-6 items-center justify-center rounded border-none shadow-none p-0"
          >
            <Icon
              name="branch"
              size={14}
              tint={() =>
                isChanged() ? theme().ui.foreground : theme().ui.mutedForeground
              }
            />
          </Button>

          <Button
            testID="sidebar-open-folder"
            onPress={props.onOpenFolder}
            class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
          >
            <Icon
              name="folder-open"
              size={14}
              tint={() => theme().ui.mutedForeground}
            />
          </Button>

          <Button
            testID="sidebar-close-folder"
            onPress={props.onCloseFolder}
            class="h-6 w-6 items-center justify-center rounded bg-transparent border-none shadow-none p-0"
          >
            <Icon
              name="close"
              size={12}
              tint={() => theme().ui.mutedForeground}
            />
          </Button>
        </View>
      </View>

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
          if (!isFolderItem(props.treeItems(), selected)) {
            props.onSelectFile(selected, props.filterMode() === "changed");
          }
        }}
        renderItem={(entry: TreeEntry) =>
          renderTreeRow(
            entry,
            props.gitStatusMap,
            props.expandedIds,
            props.selectedPath,
            props.root,
            theme
          )
        }
        class="flex-1 px-2 py-1"
      />
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
  showFileBadge: Accessor<boolean>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <View class="h-8 px-3 flex-row items-center justify-between gap-2 select-none">
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
      <If when={!!props.entry.shortcutLabel}>
        <Text
          style={{ color: props.theme().ui.mutedForeground }}
          class="text-[11px] font-mono shrink-0"
        >
          {props.entry.shortcutLabel}
        </Text>
      </If>
    </View>
  );
}

function resolveCommandPlaceholder(
  isFiles: boolean,
  root: string
): string {
  if (!isFiles) return "Run a command";
  if (!root) return "Switch recent workspace";
  const parts = root.split("/").filter(Boolean);
  return `Search ${parts[parts.length - 1] || "workspace"}`;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const query = signal("");
  const theme = computed(() => props.theme?.() ?? EDITOR_THEMES[0]);

  effect(() => {
    if (props.open()) {
      query.set("");
    }
  });

  const isFiles = computed(() => props.mode() === "files");
  const showFileBadge = computed(() => isFiles() && props.root().length > 0);
  const items = computed(() =>
    isFiles() ? props.fileItems() : props.commandItems()
  );
  const placeholder = computed(() =>
    resolveCommandPlaceholder(isFiles(), props.root())
  );

  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => props.open.set(open)}
      closeOnEscape
      closeOnBackdropPress
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      style={{
        marginHorizontal: "auto",
        marginTop: 8,
        width: 520,
        maxWidth: "92%",
      }}
    >
      <Command
        testID="command-palette"
        items={items()}
        query={query()}
        onQueryChange={({ query: q }) => query.set(q)}
        onSelect={({ id }) => {
          props.open.set(false);
          if (isFiles()) {
            props.onSelectFile(id);
          } else {
            props.onRunCommand(id);
          }
        }}
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
        class="overflow-hidden rounded-lg shadow-2xl w-full"
        searchBarClass="h-10 flex-row items-center gap-2 px-3"
        searchClass="flex-1 h-8 text-xs text-foreground placeholder:text-muted-foreground"
        searchStyle={{ height: 32, color: theme().ui.foreground }}
        listClass="p-1.5 max-h-80"
        groupClass="px-2 pt-2 pb-1"
        separatorClass="my-1 h-px bg-transparent"
        itemClass="group rounded hover:bg-muted/60 focus:bg-accent active:opacity-80"
        renderGroup={(group) => (
          <CommandGroupHeading group={group} theme={theme} />
        )}
        renderItem={(entry) => (
          <CommandItemRow
            entry={entry}
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
    </Dialog>
  );
}
