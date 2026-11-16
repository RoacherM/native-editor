import * as os from "os";
import * as path from "path";
import {
  Canvas,
  computed,
  signal,
  Text,
  View,
  type Accessor,
  type CanvasRenderingContext2D,
  type JSX,
} from "nsh";
import type { EditorTheme } from "./themes";
import { Keycap, SurfaceButton } from "./ui";
import { shortenHomePath } from "./workspace";

// DESIGN.md「界面设计语言（Industrial）」: asymmetric Swiss/Bauhaus poster — left typography + right 3×3 square-and-circle study.
const POSTER_FONT = "Helvetica Neue";
const MAX_RECENT_WORKSPACES = 5;

export const BAUHAUS_MINERALS = {
  light: { vermilion: "#d1381e", ochre: "#d99b16", cobalt: "#234f87" },
  dark: { vermilion: "#e0482d", ochre: "#dfa428", cobalt: "#3568a6" },
} as const;

const WELCOME_SHORTCUTS: readonly { shortcut: string; label: string }[] = [
  { shortcut: "mod+o", label: "Open folder" },
  { shortcut: "mod+p", label: "Quick open" },
  { shortcut: "mod+j", label: "Terminal" },
];

export interface PosterBox {
  w: number;
  h: number;
}

export interface PosterGrid {
  w: number;
  h: number;
  pad: number;
  colW: number;
  split: number;
  title: number;
  fieldX: number;
  fieldY: number;
  fieldSize: number;
  cell: number;
}

function positiveOr(value: number, fallback: number): number {
  return value > 0 ? value : fallback;
}

export function posterGrid(raw: PosterBox): PosterGrid {
  const w = positiveOr(raw.w, 1280);
  const h = positiveOr(raw.h, 744);
  const pad = Math.max(24, Math.min(48, Math.round((Math.min(w, h) * 0.064) / 4) * 4));
  const colW = Math.max(180, Math.min(432, w - pad * 2, Math.round(w * 0.35)));
  const split = pad + colW + pad;
  const title = Math.round(Math.max(56, Math.min(84, Math.min(w, h) * 0.1)));
  const availSide = Math.min(w - split - pad, h - pad * 2, 720);
  const evenCell = Math.floor(availSide / 6) * 2;
  const cell = evenCell >= 32 ? evenCell : 0;
  const fieldSize = cell * 3;
  const fieldX = w - pad - fieldSize;
  const fieldY = Math.round((h - fieldSize) / 2);
  return { w, h, pad, colW, split, title, fieldX, fieldY, fieldSize, cell };
}

function fillCircle(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  cx.beginPath();
  cx.arc(x, y, radius, 0, Math.PI * 2);
  cx.fillStyle = color;
  cx.fill();
}

function fillQuarterDisc(
  cx: CanvasRenderingContext2D,
  cornerX: number,
  cornerY: number,
  radius: number,
  startAngle: number,
  color: string,
): void {
  cx.beginPath();
  cx.moveTo(cornerX, cornerY);
  cx.arc(cornerX, cornerY, radius, startAngle, startAngle + Math.PI / 2);
  cx.closePath();
  cx.fillStyle = color;
  cx.fill();
}

function strokeModularGrid(
  cx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  size: number,
  cell: number,
  borderColor: string,
): void {
  cx.beginPath();
  for (let i = 1; i <= 2; i += 1) {
    const gx = x0 + i * cell + 0.5;
    const gy = y0 + i * cell + 0.5;
    cx.moveTo(gx, y0);
    cx.lineTo(gx, y0 + size);
    cx.moveTo(x0, gy);
    cx.lineTo(x0 + size, gy);
  }
  cx.strokeStyle = borderColor;
  cx.lineWidth = 1;
  cx.stroke();
}

export function drawBauhausComposition(
  cx: CanvasRenderingContext2D,
  raw: PosterBox,
  theme: EditorTheme,
): void {
  if (raw.w <= 0 || raw.h <= 0) return;
  const grid = posterGrid(raw);
  if (grid.fieldSize <= 0) return;

  const { fieldX: x0, fieldY: y0, fieldSize: s, cell: c } = grid;
  const r = c / 2;
  const mineral = BAUHAUS_MINERALS[theme.appearance];
  const { background: bg, sidebar: surface, border: stone, foreground: ink } = theme.ui;

  cx.save();
  cx.beginPath();
  cx.rect(x0, y0, s, s);
  cx.clip();

  // (2,0) outer surface ground drawn before modular grid hairlines so its borders lock cleanly
  cx.fillStyle = surface;
  cx.fillRect(x0 + 2 * c, y0, c, c);
  strokeModularGrid(cx, x0, y0, s, c, stone);

  // (0,0) Inscribed Cobalt circle with concentric background aperture lens
  fillCircle(cx, x0 + r, y0 + r, r, mineral.cobalt);
  fillCircle(cx, x0 + r, y0 + r, Math.round(c * 0.2), bg);

  // (1,0) + (1,1) Counter-balanced Bauhaus rotor (tangent c-radius quarter-discs)
  fillQuarterDisc(cx, x0 + 2 * c, y0 + c, c, Math.PI, ink);
  fillQuarterDisc(cx, x0 + c, y0 + c, c, 0, stone);

  // (2,0) Josef Albers nested Vermilion square (0.56c centered inside surface cell)
  const albersSq = Math.round(c * 0.56);
  const albersPad = Math.round((c - albersSq) / 2);
  cx.fillStyle = mineral.vermilion;
  cx.fillRect(x0 + 2 * c + albersPad, y0 + albersPad, albersSq, albersSq);

  // (0,1) Architectural breathing cell: inscribed hairline circle + centered stone square
  cx.beginPath();
  cx.arc(x0 + r, y0 + c + r, r - 0.5, 0, Math.PI * 2);
  cx.strokeStyle = stone;
  cx.lineWidth = 1;
  cx.stroke();
  const coreSq = Math.round(c * 0.28);
  const corePad = Math.round((c - coreSq) / 2);
  cx.fillStyle = stone;
  cx.fillRect(x0 + corePad, y0 + c + corePad, coreSq, coreSq);

  // (2,1) Inscribed Ochre Gold full circle
  fillCircle(cx, x0 + 2 * c + r, y0 + c + r, r, mineral.ochre);

  // (0,2) + (1,2) + (2,2) Bottom arch: Vermilion quarter-disc, Ink square + aperture, Cobalt quarter-disc
  fillQuarterDisc(cx, x0 + c, y0 + 2 * c, c, Math.PI / 2, mineral.vermilion);
  cx.fillStyle = ink;
  cx.fillRect(x0 + c, y0 + 2 * c, c, c);
  fillCircle(cx, x0 + c + r, y0 + 2 * c + r, Math.round(c * 0.28), bg);
  fillQuarterDisc(cx, x0 + 2 * c, y0 + 2 * c, c, 0, mineral.cobalt);

  // Crisp 1px outer architectural frame
  cx.strokeStyle = stone;
  cx.lineWidth = 1;
  cx.strokeRect(x0 + 0.5, y0 + 0.5, s - 1, s - 1);
  cx.restore();
}

function PosterFields(props: {
  box: Accessor<PosterBox>;
  theme: Accessor<EditorTheme>;
}): JSX.Element {
  return (
    <Canvas
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
      draw={(cx, size) =>
        drawBauhausComposition(
          cx,
          { w: Math.round(size.width || props.box().w), h: Math.round(size.height || props.box().h) },
          props.theme(),
        )
      }
    />
  );
}

function formatLedgerIndex(n: number): string {
  return String(n).padStart(2, "0");
}

function PosterRecent(props: {
  items: Accessor<string[]>;
  home: string;
  theme: Accessor<EditorTheme>;
  onSelect: (folderPath: string) => void;
}): JSX.Element {
  return (
    <View class="gap-2">
      <View class="flex-row items-center justify-between">
        <Text
          class="text-xs font-medium text-muted-foreground"
          style={{ color: props.theme().ui.mutedForeground, fontFamily: POSTER_FONT }}
        >
          Recent
        </Text>
        <Text
          class="text-[11px] font-mono tabular-nums text-muted-foreground"
          style={{ color: props.theme().ui.mutedForeground }}
        >
          {formatLedgerIndex(props.items().length)}
        </Text>
      </View>
      <View class="gap-0.5">
        <Each of={props.items()} key={(w) => w}>
          {(ws, index) => {
            const base = () => path.basename(ws()) || ws();
            return (
              <SurfaceButton
                variant="ghost"
                testID={`welcome-recent-${base()}`}
                onPress={() => props.onSelect(ws())}
                class="h-8 -mx-2 px-2 rounded justify-between items-center gap-3 hover:bg-sidebar"
              >
                <View class="flex-row items-center gap-3 shrink-0">
                  <Text
                    class="w-5 text-[11px] font-mono tabular-nums shrink-0"
                    style={{ color: props.theme().ui.accent }}
                  >
                    {formatLedgerIndex(index() + 1)}
                  </Text>
                  <Text
                    class="text-[13px] font-medium text-foreground"
                    style={{ color: props.theme().ui.foreground, fontFamily: POSTER_FONT }}
                  >
                    {base()}
                  </Text>
                </View>
                <Text
                  class="text-[11px] font-mono text-muted-foreground flex-1 min-w-0 truncate text-right"
                  style={{ color: props.theme().ui.mutedForeground }}
                >
                  {shortenHomePath(path.dirname(ws()), props.home)}
                </Text>
              </SurfaceButton>
            );
          }}
        </Each>
      </View>
    </View>
  );
}

function PosterShortcutHints(props: { theme: Accessor<EditorTheme> }): JSX.Element {
  return (
    <View
      testID="welcome-shortcut-hints"
      class="pt-3.5 flex-row items-center flex-wrap gap-x-4 gap-y-2"
      style={{
        borderTopWidth: 1,
        borderTopColor: props.theme().ui.border,
      }}
    >
      <Each of={WELCOME_SHORTCUTS} key={(item) => item.shortcut}>
        {(item) => (
          <View class="flex-row items-center gap-1.5">
            <Keycap shortcut={item().shortcut} />
            <Text
              class="text-xs text-muted-foreground"
              style={{ color: props.theme().ui.mutedForeground, fontFamily: POSTER_FONT }}
            >
              {item().label}
            </Text>
          </View>
        )}
      </Each>
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
    const reserved = g.title + 124;
    const rows = Math.floor((g.h - g.pad * 2 - reserved) / 34);
    return props.recentWorkspaces().slice(0, Math.max(0, Math.min(MAX_RECENT_WORKSPACES, rows)));
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
        class="absolute justify-between"
        style={{
          left: grid().pad,
          top: grid().pad,
          bottom: grid().pad,
          width: grid().colW,
        }}
      >
        <View class="gap-6">
          <View
            class="pb-4"
            style={{
              borderBottomWidth: 1,
              borderBottomColor: props.theme().ui.border,
            }}
          >
            <Text
              style={{
                color: props.theme().ui.foreground,
                fontFamily: POSTER_FONT,
                fontWeight: "bold",
                fontSize: grid().title,
                lineHeight: Math.round(grid().title * 0.92),
                letterSpacing: -Math.round(grid().title * 0.035),
              }}
            >
              Aed
            </Text>
          </View>
          <If when={recentFit().length > 0}>
            <PosterRecent
              items={recentFit}
              home={home}
              theme={props.theme}
              onSelect={props.onSelectRecentWorkspace}
            />
          </If>
        </View>
        <PosterShortcutHints theme={props.theme} />
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
