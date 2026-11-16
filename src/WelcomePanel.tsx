import * as os from "os";
import * as path from "path";
import { Canvas, computed, signal, Text, View, type Accessor, type CanvasRenderingContext2D, type JSX } from "nsh";
import type { EditorTheme } from "./themes";
import { Keycap, SurfaceButton } from "./ui";
import { shortenHomePath } from "./workspace";

// DESIGN.md「界面设计语言（Industrial）」: Bauhaus poster of an abstract `open(path)` on a character grid.
const POSTER_FONT = "Helvetica Neue";

const POSTER_PRIMARIES = {
  light: { red: "#d7381e", yellow: "#e8a90c", blue: "#1f4e8c" },
  dark: { red: "#e8462b", yellow: "#e9ae1a", blue: "#3b6fb6" },
} as const;

type PosterRole = "keyword" | "type" | "string" | "name";
type PosterToken = readonly [chars: number, role: PosterRole];

const POSTER_CODE: readonly (readonly [indent: number, tokens: readonly PosterToken[]])[] = [
  [0, [[2, "keyword"], [4, "name"], [6, "type"]]],
  [2, [[3, "keyword"], [4, "name"], [1, "name"], [8, "name"]]],
  [2, [[5, "keyword"], [4, "name"]]],
  [4, [[4, "type"], [2, "name"], [6, "string"]]],
  [4, [[5, "type"], [2, "name"], [6, "string"]]],
  [4, [[5, "type"], [2, "name"], [4, "string"]]],
  [2, [[1, "name"]]],
  [0, [[1, "name"]]],
];

const POSTER_COLUMNS = 17;
const POSTER_SELECTION = [3, 5] as const;

interface PosterBox {
  w: number;
  h: number;
}

interface PosterGrid {
  w: number;
  h: number;
  pad: number;
  split: number;
  title: number;
}

export function posterGrid(box: PosterBox): PosterGrid {
  const w = Math.max(480, box.w);
  const h = Math.max(240, box.h);
  const pad = Math.round(Math.max(24, Math.min(64, Math.min(w, h) * 0.055)));
  const split = Math.round(Math.max(w * 0.48, Math.min(w - 140, 420)));
  const colW = Math.max(200, split - pad * 2);
  const availTitleH = Math.max(56, h - pad * 2 - 56);
  const title = Math.round(Math.max(56, Math.min(104, colW / 2.4, availTitleH, h / 4.2)));
  return { w, h, pad, split, title };
}

function drawPosterBars(
  cx: CanvasRenderingContext2D,
  raw: PosterBox,
  theme: EditorTheme,
): void {
  if (raw.w <= 0 || raw.h <= 0) return;
  const hue = POSTER_PRIMARIES[theme.appearance];
  const fill: Record<PosterRole, string> = {
    keyword: hue.red,
    type: hue.blue,
    string: hue.yellow,
    name: theme.ui.foreground,
  };
  const { w, h, pad, split } = posterGrid(raw);
  const lines = POSTER_CODE.length * 2 - 1;
  const u = Math.min((w - split) / POSTER_COLUMNS, (h - pad * 2) / lines);
  const lineTop = (i: number) => h - pad - lines * u + i * 2 * u;

  const [first, last] = POSTER_SELECTION;
  const selX = split + (POSTER_CODE[first][0] - 0.5) * u;
  const selY = lineTop(first) - u / 2;
  cx.fillStyle = theme.ui.border;
  cx.fillRect(selX, selY, w - selX, (last - first + 1) * 2 * u);

  POSTER_CODE.forEach(([indent, tokens], i) => {
    let x = split + indent * u;
    for (const [chars, role] of tokens) {
      cx.fillStyle = fill[role];
      cx.fillRect(x, lineTop(i), chars * u, u);
      x += (chars + 1) * u;
    }
  });
  cx.fillStyle = hue.red;
  cx.fillRect(selX, selY, u / 3, 2 * u);
}

function PosterFields(props: {
  box: Accessor<PosterBox>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <Canvas
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
      draw={(cx) => drawPosterBars(cx, props.box(), props.theme())}
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
        class="text-xs font-medium pb-1 text-muted-foreground"
        style={{ fontFamily: POSTER_FONT }}
      >
        Recent
      </Text>
      <Each of={props.items()} key={(w) => w}>
        {(ws, index) => {
          const base = () => path.basename(ws()) || ws();
          return (
            <SurfaceButton
              variant="ghost"
              testID={`welcome-recent-${base()}`}
              onPress={() => props.onSelect(ws())}
              class="-mx-2 px-2 justify-start gap-3 hover:bg-sidebar"
            >
              <Text class="w-5 text-[11px] font-mono tabular-nums text-primary shrink-0">
                {String(index() + 1).padStart(2, "0")}
              </Text>
              <Text
                class="text-[13px] font-medium text-foreground shrink-0"
                style={{ fontFamily: POSTER_FONT }}
              >
                {base()}
              </Text>
              <Text class="text-[11px] font-mono text-muted-foreground flex-1 min-w-0 truncate">
                {shortenHomePath(path.dirname(ws()), props.home)}
              </Text>
            </SurfaceButton>
          );
        }}
      </Each>
    </View>
  );
}

function PosterShortcutHints(): JSX.Element {
  return (
    <View testID="welcome-shortcut-hints" class="pt-4 flex-row items-center flex-wrap gap-2">
      <Keycap shortcut="mod+o" />
      <Text class="text-xs text-muted-foreground" style={{ fontFamily: POSTER_FONT }}>
        Open folder
      </Text>
      <Text class="text-xs text-muted-foreground px-0.5">·</Text>
      <Keycap shortcut="mod+j" />
      <Text class="text-xs text-muted-foreground" style={{ fontFamily: POSTER_FONT }}>
        Terminal
      </Text>
    </View>
  );
}

export interface WelcomePanelProps {
  recentWorkspaces: Accessor<string[]>;
  theme: Accessor<EditorTheme>;
  onSelectRecentWorkspace: (folderPath: string) => void;
}

export function WelcomePanel(props: WelcomePanelProps): JSX.Element {
  const home = os.homedir();
  const box = signal<PosterBox>({ w: 0, h: 0 });
  const grid = computed(() => posterGrid(box()));
  const recentFit = computed(() => {
    const g = grid();
    const top = g.pad + g.title + 96;
    const rows = Math.floor((g.h - g.pad - top) / 28);
    return props.recentWorkspaces().slice(0, Math.max(0, Math.min(5, rows)));
  });

  return (
    <View
      testID="welcome-panel"
      class="flex-1 overflow-hidden select-none bg-background"
      style={{ backgroundColor: props.theme().ui.background }}
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
          maxHeight: Math.max(0, grid().h - grid().pad * 2),
        }}
      >
        <Text
          style={{
            color: props.theme().ui.foreground,
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
          style={{ color: props.theme().ui.mutedForeground, fontFamily: POSTER_FONT }}
        >
          Another editor for code, documents, data and media.
        </Text>
        <If
          when={props.recentWorkspaces().length > 0}
          else={<PosterShortcutHints />}
        >
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
        </If>
      </View>
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
    <SurfaceButton
      variant="ghost"
      testID={props.id}
      onPress={props.onPress}
      class="w-full justify-between gap-6 px-2.5 hover:bg-sidebar"
    >
      <Text
        style={{ color: props.theme().ui.mutedForeground }}
        class="text-xs text-muted-foreground"
      >
        {props.label}
      </Text>
      <Keycap shortcut={props.shortcut} />
    </SurfaceButton>
  );
}

export interface EmptyEditorPanelProps {
  theme: Accessor<EditorTheme>;
  onQuickOpen: () => void;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  onToggleTerminal: () => void;
}

export function EmptyEditorPanel(props: EmptyEditorPanelProps): JSX.Element {
  return (
    <View
      testID="empty-editor-panel"
      class="flex-1 items-center justify-center select-none bg-background"
      style={{ backgroundColor: props.theme().ui.background }}
    >
      <View class="w-[236px] flex-col gap-1">
        <EmptyEditorShortcutRow
          id="empty-editor-quick-open"
          label="Search Files"
          shortcut="mod+p"
          theme={props.theme}
          onPress={props.onQuickOpen}
        />
        <EmptyEditorShortcutRow
          id="empty-editor-open-folder"
          label="Open Folder"
          shortcut="mod+o"
          theme={props.theme}
          onPress={props.onOpenFolder}
        />
        <EmptyEditorShortcutRow
          id="empty-editor-close-folder"
          label="Close Folder"
          shortcut="mod+shift+w"
          theme={props.theme}
          onPress={props.onCloseFolder}
        />
        <EmptyEditorShortcutRow
          id="empty-editor-toggle-terminal"
          label="Toggle Terminal"
          shortcut="mod+j"
          theme={props.theme}
          onPress={props.onToggleTerminal}
        />
      </View>
    </View>
  );
}
