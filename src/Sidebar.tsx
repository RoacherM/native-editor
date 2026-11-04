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
import { lookupGitStatus, type GitStatusCode } from "./workspace";

export interface SidebarProps {
  root: Accessor<string>;
  filterMode: Signal<"all" | "changed">;
  treeItems: Accessor<TreeItem[]>;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  gitStatusMap: Accessor<Record<string, GitStatusCode>>;
  onSelectFile: (filePath: string, openInDiff?: boolean) => void;
  onOpenFolder: () => void;
}

export interface CommandPaletteProps {
  open: Signal<boolean>;
  mode: Accessor<"files" | "commands">;
  root: Accessor<string>;
  fileItems: Accessor<CommandItem[]>;
  commandItems: Accessor<CommandItem[]>;
  onSelectFile: (filePath: string) => void;
  onRunCommand: (commandId: string) => void;
}

function getGitBadgeClass(status?: GitStatusCode): string {
  if (status === "M") return "text-[10.5px] font-mono font-medium text-amber-400 ml-1.5";
  if (status === "A" || status === "U")
    return "text-[10.5px] font-mono font-medium text-emerald-400 ml-1.5";
  if (status === "D") return "text-[10.5px] font-mono font-medium text-rose-400 ml-1.5";
  return "text-[10.5px] font-mono font-medium text-muted-foreground ml-1.5";
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
  root: Accessor<string>
): JSX.Element {
  const status = computed(() => lookupGitStatus(entry.id, root(), statusMap()));
  const isExpanded = computed(() => expandedIds().includes(entry.id));
  return (
    <View
      class="flex-row items-center h-6 pr-2 hover:bg-muted/40 active:bg-muted/60 rounded select-none gap-1.5"
      style={{ paddingLeft: entry.depth * 12 + 8 }}
    >
      <If when={entry.folder}>
        <If when={isExpanded()}>
          <Icon name="chevron-down" size={11} tint="#8a8a8a" />
        </If>
        <If when={!isExpanded()}>
          <Icon name="chevron-right" size={11} tint="#8a8a8a" />
        </If>
      </If>
      <If when={!entry.folder}>
        <FileBadge name={entry.label} />
      </If>
      <Text class="truncate text-xs text-foreground flex-1">
        {entry.label}
      </Text>
      <If when={!!status()}>
        <Text class={getGitBadgeClass(status())}>{status()}</Text>
      </If>
    </View>
  );
}

const TreeView = Tree as unknown as (
  props: import("nsh/base").TreeProps & { rowHeight?: number }
) => JSX.Element;

export function Sidebar(props: SidebarProps): JSX.Element {
  const folderName = computed(() => {
    const raw = props.root();
    const parts = raw.split("/").filter(Boolean);
    return (parts[parts.length - 1] || "workspace").toUpperCase();
  });
  const isAll = computed(() => props.filterMode() === "all");
  const isChanged = computed(() => props.filterMode() === "changed");

  return (
    <View class="flex-1 bg-sidebar select-none overflow-hidden">
      <View class="h-[28px] px-2 flex-row items-center justify-between shrink-0">
        <Button
          testID="sidebar-open-folder"
          onPress={props.onOpenFolder}
          class="flex-1 min-w-0 flex-row items-center gap-1 bg-transparent hover:opacity-80 p-0 border-none shadow-none"
        >
          <Icon name="chevron-down" size={11} tint="#8a8a8a" />
          <Text class="text-[11px] font-bold tracking-wider text-muted-foreground truncate">
            {folderName()}
          </Text>
        </Button>

        <View class="flex-row items-center gap-0.5 shrink-0">
          <Button
            testID="sidebar-filter-all"
            selected={isAll()}
            onPress={() => props.filterMode.set("all")}
            class={`h-5 w-5 items-center justify-center rounded border-none shadow-none p-0 ${
              isAll() ? "bg-muted/70" : "bg-transparent hover:bg-muted/40"
            }`}
          >
            <Icon name="files" size={13} tint={isAll() ? "#e5e5e5" : "#808080"} />
          </Button>

          <Button
            testID="sidebar-filter-changed"
            selected={isChanged()}
            onPress={() => props.filterMode.set("changed")}
            class={`h-5 w-5 items-center justify-center rounded border-none shadow-none p-0 ${
              isChanged() ? "bg-muted/70" : "bg-transparent hover:bg-muted/40"
            }`}
          >
            <Icon name="branch" size={13} tint={isChanged() ? "#e5e5e5" : "#808080"} />
          </Button>
        </View>
      </View>

      <TreeView
        testID="workspace-tree"
        rowHeight={24}
        itemClass="h-6"
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
            props.root
          )
        }
        class="flex-1 pt-0.5 px-1.5 pb-1.5"
      />
    </View>
  );
}

function CommandGroupHeading(props: { group: CommandGroup }): JSX.Element {
  return (
    <Text class="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
      {props.group.heading}
    </Text>
  );
}

function CommandItemRow(props: { entry: CommandEntry }): JSX.Element {
  return (
    <View class="h-8 px-2.5 flex-row items-center gap-2 select-none">
      <FileBadge name={props.entry.label} />
      <Text class="text-[12.5px] text-foreground truncate flex-1">
        {props.entry.label}
      </Text>
    </View>
  );
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const query = signal("");

  effect(() => {
    if (props.open()) {
      query.set("");
    }
  });

  const isFiles = computed(() => props.mode() === "files");
  const items = computed(() => (isFiles() ? props.fileItems() : props.commandItems()));
  const folderName = computed(() => {
    const raw = props.root();
    const parts = raw.split("/").filter(Boolean);
    return parts[parts.length - 1] || "workspace";
  });
  const placeholder = computed(() =>
    isFiles() ? `Search files in ${folderName()}...` : "Search commands..."
  );

  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => props.open.set(open)}
      closeOnEscape
      closeOnBackdropPress
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      style={{ marginHorizontal: "auto", marginTop: 6, width: 520, maxWidth: "92%" }}
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
        searchPrefix={<Icon name="search" size={13} tint="#888888" />}
        class="overflow-hidden rounded-lg border border-border bg-popover shadow-2xl w-full"
        searchBarClass="h-10 flex-row items-center gap-2 border-b border-border px-3"
        searchClass="flex-1 h-8 text-xs text-foreground placeholder:text-muted-foreground"
        searchStyle={{ height: 32 }}
        listClass="p-1.5 max-h-80"
        groupClass="px-2 pt-2 pb-1"
        separatorClass="-mx-1.5 my-1 h-px bg-border"
        itemClass="group rounded border border-transparent hover:bg-muted/60 focus:bg-accent active:opacity-80"
        renderGroup={(group) => <CommandGroupHeading group={group} />}
        renderItem={(entry) => <CommandItemRow entry={entry} />}
        empty={
          <View class="py-6 items-center">
            <Text class="text-xs text-muted-foreground">No matching results</Text>
          </View>
        }
      />
    </Dialog>
  );
}
