import * as os from "os";
import * as path from "path";
import { mount, signal, View, type CanvasRenderingContext2D, type JSX } from "nsh";
import { describe, expect, open, test } from "nsh/test";
import { EDITOR_THEMES, getThemeById } from "./themes";
import * as welcomeMod from "./WelcomePanel";
import {
  BAUHAUS_MINERALS,
  drawBauhausComposition,
  EmptyEditorPanel,
  posterGrid,
  WelcomePanel,
} from "./WelcomePanel";
import { shortenHomePath } from "./workspace";

const FIXTURE_ROOT = decodeURIComponent(new URL("../fixtures", import.meta.url).pathname).replace(
  /\/+$/,
  "",
);

function hexRgba(hex: string): string {
  return `${hex.toLowerCase()}ff`;
}

interface RecordedCanvas {
  cx: CanvasRenderingContext2D;
  arcs: { x: number; y: number; r: number; start: number; end: number; fill?: string; stroke?: string }[];
  rects: { x: number; y: number; w: number; h: number; kind: "fill" | "stroke" | "clip"; color: string }[];
  fills: string[];
  saves: number;
  restores: number;
}

function createRecordingCanvas(): RecordedCanvas {
  const rec: Omit<RecordedCanvas, "cx"> = {
    arcs: [],
    rects: [],
    fills: [],
    saves: 0,
    restores: 0,
  };
  let lastArc: { x: number; y: number; r: number; start: number; end: number } | null = null;
  let lastClipRect: { x: number; y: number; w: number; h: number } | null = null;

  const state = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    save() {
      rec.saves += 1;
    },
    restore() {
      rec.restores += 1;
    },
    beginPath() {
      lastArc = null;
      lastClipRect = null;
    },
    closePath() {},
    moveTo() {},
    lineTo() {},
    rect(x: number, y: number, w: number, h: number) {
      lastClipRect = { x, y, w, h };
    },
    clip() {
      if (lastClipRect) {
        rec.rects.push({ ...lastClipRect, kind: "clip", color: "" });
      }
    },
    arc(x: number, y: number, r: number, start: number, end: number) {
      lastArc = { x, y, r, start, end };
    },
    fill() {
      const color = String(state.fillStyle);
      rec.fills.push(color);
      if (lastArc) {
        rec.arcs.push({ ...lastArc, fill: color });
      }
    },
    stroke() {
      if (lastArc) {
        rec.arcs.push({ ...lastArc, stroke: String(state.strokeStyle) });
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const color = String(state.fillStyle);
      rec.fills.push(color);
      rec.rects.push({ x, y, w, h, kind: "fill", color });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      rec.rects.push({ x, y, w, h, kind: "stroke", color: String(state.strokeStyle) });
    },
  };

  return Object.assign(rec, { cx: state as unknown as CanvasRenderingContext2D });
}

describe("WelcomePanel Bauhaus square-and-circle poster & grounded left column", () => {
  test("posterGrid computes an even-cell 3x3 inset square field that never overflows margins and keeps title >= 56pt", () => {
    for (const [w, h] of [
      [1280, 744],
      [1512, 926],
      [760, 464],
    ]) {
      const g = posterGrid({ w, h });
      expect(g.title).toBeGreaterThanOrEqual(56);
      expect(g.title).toBeLessThanOrEqual(84);
      expect(g.colW).toBe(g.split - g.pad * 2);
      expect(g.cell).toBeGreaterThan(0);
      expect(g.cell % 2).toBe(0);
      expect(g.fieldSize).toBe(g.cell * 3);
      expect(g.fieldX).toBeGreaterThanOrEqual(g.split - g.pad);
      expect(g.fieldX + g.fieldSize).toBeLessThanOrEqual(w - g.pad);
      expect(g.fieldY).toBeGreaterThanOrEqual(g.pad);
      expect(g.fieldY + g.fieldSize).toBeLessThanOrEqual(h - g.pad);
    }

    const narrow = posterGrid({ w: 280, h: 394 });
    expect(narrow.title).toBeGreaterThanOrEqual(56);
    expect(narrow.fieldSize).toBe(0);

    const compiled = Object.values(welcomeMod).map(String).join("\n");
    expect(compiled).not.toContain("Another editor for code");
    expect(compiled).not.toContain("POSTER_CODE");
  });

  test("drawBauhausComposition renders clipped 3x3 squares, Albers nested square, full circles, and quarter-discs inside bounds", () => {
    const darkTheme = getThemeById("industrial-carbon");
    const lightTheme = getThemeById("industrial-paper");
    const box = { w: 1280, h: 744 };
    const g = posterGrid(box);

    const darkCanvas = createRecordingCanvas();
    drawBauhausComposition(darkCanvas.cx, box, darkTheme);
    expect(darkCanvas.saves).toBe(1);
    expect(darkCanvas.restores).toBe(1);

    // Must render circles/quarter-discs via arc() AND squares via fillRect()
    expect(darkCanvas.arcs.length).toBeGreaterThanOrEqual(7);
    expect(darkCanvas.rects.filter((r) => r.kind === "fill").length).toBeGreaterThanOrEqual(4);

    // Uses archival mineral palette + theme.ui colors
    expect(darkCanvas.fills).toContain(BAUHAUS_MINERALS.dark.vermilion);
    expect(darkCanvas.fills).toContain(BAUHAUS_MINERALS.dark.ochre);
    expect(darkCanvas.fills).toContain(BAUHAUS_MINERALS.dark.cobalt);
    expect(darkCanvas.fills).toContain(darkTheme.ui.foreground);

    // Every filled square stays strictly inside the S x S inset field (zero window overflow)
    for (const rect of darkCanvas.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(g.fieldX);
      expect(rect.y).toBeGreaterThanOrEqual(g.fieldY);
      expect(rect.x + rect.w).toBeLessThanOrEqual(g.fieldX + g.fieldSize);
      expect(rect.y + rect.h).toBeLessThanOrEqual(g.fieldY + g.fieldSize);
    }

    const lightCanvas = createRecordingCanvas();
    drawBauhausComposition(lightCanvas.cx, box, lightTheme);
    expect(lightCanvas.fills).toContain(BAUHAUS_MINERALS.light.vermilion);
    expect(lightCanvas.fills).toContain(BAUHAUS_MINERALS.light.ochre);
    expect(lightCanvas.fills).toContain(BAUHAUS_MINERALS.light.cobalt);

    // Narrow or zero-sized boxes are safe no-ops
    const tinyCanvas = createRecordingCanvas();
    drawBauhausComposition(tinyCanvas.cx, { w: 280, h: 394 }, darkTheme);
    drawBauhausComposition(tinyCanvas.cx, { w: 0, h: 0 }, darkTheme);
    expect(tinyCanvas.arcs).toHaveLength(0);
    expect(tinyCanvas.rects).toHaveLength(0);
  });

  test("empty state renders Aed >= 56pt, bottom-grounded keycap strip, and no Open Folder button or filler slogan", async () => {
    const carbon = getThemeById("industrial-carbon");
    const app = await open("../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "aed.recentWorkspaces": "[]",
        "aed.theme": carbon.id,
      },
    });

    await app.waitFor("id:welcome-panel");
    expect(app.shows("text:Aed")).toBe(true);
    expect(app.shows("text:Recent")).toBe(false);
    expect(app.shows("text:Open Folder")).toBe(false);
    expect(app.shows("id:welcome-open-folder")).toBe(false);
    expect(app.texts().some((t) => t.includes("Another editor"))).toBe(false);

    expect(app.shows("id:welcome-shortcut-hints")).toBe(true);
    expect(app.shows("text:Open folder")).toBe(true);
    expect(app.shows("text:Quick open")).toBe(true);
    expect(app.shows("text:Terminal")).toBe(true);
    expect(app.spanStyle("text:Aed").color).toBe(hexRgba(carbon.ui.foreground));
    expect(app.spanStyle("text:Aed").fontSize).toBeGreaterThanOrEqual(56);

    await app.setViewport(280, 450);
    expect(app.spanStyle("text:Aed").fontSize).toBeGreaterThanOrEqual(56);
  });

  test("Recent list renders up to 5 indexed rows with shortened parent paths, keeps shortcut hints visible, reacts to themes, and opens workspace", async () => {
    const home = os.homedir();
    const tokyo = getThemeById("tokyo-night");
    const paper = getThemeById("industrial-paper");
    const fixtureParent = shortenHomePath(path.dirname(FIXTURE_ROOT), home);
    const recentList = [
      FIXTURE_ROOT,
      path.join(home, "Projects", "alpha"),
      path.join(home, "Projects", "beta"),
      path.join(home, "Projects", "gamma"),
      path.join(home, "Projects", "delta"),
      path.join(home, "Projects", "overflow-sixth"),
    ];

    const app = await open("../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      storage: {
        "aed.recentWorkspaces": JSON.stringify(recentList),
        "aed.theme": tokyo.id,
      },
    });

    await app.waitFor("id:welcome-recent-fixtures");
    expect(app.shows("text:Recent")).toBe(true);
    expect(app.shows("text:01")).toBe(true);
    expect(app.shows("text:fixtures")).toBe(true);
    expect(app.shows(`text:${fixtureParent}`)).toBe(true);
    expect(app.shows("id:welcome-recent-alpha")).toBe(true);
    expect(app.shows("text:~/Projects")).toBe(true);
    expect(app.shows("id:welcome-recent-delta")).toBe(true);
    expect(app.shows("id:welcome-recent-overflow-sixth")).toBe(false);

    expect(app.shows("id:welcome-shortcut-hints")).toBe(true);
    expect(app.shows("text:Open folder")).toBe(true);
    expect(app.shows("text:Quick open")).toBe(true);
    expect(app.shows("text:Terminal")).toBe(true);

    expect(app.spanStyle("text:Aed").color).toBe(hexRgba(tokyo.ui.foreground));
    expect(app.spanStyle("text:01").color).toBe(hexRgba(tokyo.ui.accent));

    await app.keyboard.press("mod+,");
    await app.waitFor("id:font-settings-dialog");
    await app.press(`id:theme-preset-${paper.id}`);
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:font-settings-dialog"), { timeout: 3000 });

    expect(app.spanStyle("text:Aed").color).toBe(hexRgba(paper.ui.foreground));
    expect(app.spanStyle("text:01").color).toBe(hexRgba(paper.ui.accent));

    await app.press("id:welcome-recent-fixtures");
    await app.waitFor("id:empty-editor-panel");
    expect(app.shows("id:workspace-tree")).toBe(true);
    expect(app.shows("id:welcome-panel")).toBe(false);
  });

  test("mounts WelcomePanel and EmptyEditorPanel reactively across all 8 themes", () => {
    const recent = signal<string[]>([]);
    const theme = signal(EDITOR_THEMES[0]);

    function Harness(): JSX.Element {
      return (
        <View class="flex-1">
          <WelcomePanel
            recentWorkspaces={recent}
            theme={theme}
            onSelectRecentWorkspace={() => undefined}
          />
          <EmptyEditorPanel
            theme={theme}
            onQuickOpen={() => undefined}
            onOpenFolder={() => undefined}
            onCloseFolder={() => undefined}
            onToggleTerminal={() => undefined}
          />
        </View>
      );
    }

    const unmount = mount(Harness);
    try {
      recent.set([FIXTURE_ROOT, "/tmp/demo"]);
      for (const nextTheme of EDITOR_THEMES) {
        theme.set(nextTheme);
      }
      recent.set([]);
    } finally {
      unmount();
    }
  });
});
