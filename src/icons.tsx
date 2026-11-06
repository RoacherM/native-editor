import {
  Canvas,
  computed,
  Text,
  View,
  type Accessor,
  type CanvasRenderingContext2D,
  type JSX,
} from "nsh";

export type IconName =
  | "sidebar"
  | "panel-bottom"
  | "files"
  | "terminal"
  | "search"
  | "sun"
  | "moon"
  | "refresh"
  | "folder"
  | "folder-open"
  | "file"
  | "code"
  | "diff"
  | "chevron-right"
  | "chevron-down"
  | "close"
  | "plus"
  | "external"
  | "branch"
  | "send"
  | "play"
  | "music"
  | "zoom-in"
  | "zoom-out"
  | "check";

type DrawFn = (cx: CanvasRenderingContext2D) => void;

function strokeLine(cx: CanvasRenderingContext2D, pts: number[]): void {
  cx.beginPath();
  cx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) {
    cx.lineTo(pts[i], pts[i + 1]);
  }
  cx.stroke();
}

function strokeRect(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  cx.beginPath();
  cx.roundRect(x, y, w, h, r);
  cx.stroke();
}

function strokeCircle(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number
): void {
  cx.beginPath();
  cx.arc(x, y, r, 0, Math.PI * 2);
  cx.stroke();
}

const GLYPHS: Record<IconName, DrawFn> = {
  sidebar: (c) => {
    strokeRect(c, 2.5, 3.5, 15, 13, 2);
    strokeLine(c, [7.5, 3.5, 7.5, 16.5]);
  },
  "panel-bottom": (c) => {
    strokeRect(c, 2.5, 3.5, 15, 13, 2);
    strokeLine(c, [2.5, 12.2, 17.5, 12.2]);
  },
  files: (c) => {
    strokeLine(c, [7, 2.5, 13.5, 2.5, 16.5, 5.5, 16.5, 14.5, 7, 14.5, 7, 2.5]);
    strokeLine(c, [13.5, 2.5, 13.5, 5.5, 16.5, 5.5]);
    strokeLine(c, [4, 5.5, 4, 17.5, 13.5, 17.5]);
  },
  terminal: (c) => {
    strokeRect(c, 2.5, 3.5, 15, 13, 2.5);
    strokeLine(c, [6, 8, 8.5, 10, 6, 12]);
    strokeLine(c, [10.5, 12.5, 14, 12.5]);
  },
  search: (c) => {
    strokeCircle(c, 8.8, 8.8, 4.8);
    strokeLine(c, [12.4, 12.4, 16.5, 16.5]);
  },
  sun: (c) => {
    strokeCircle(c, 10, 10, 3.3);
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4;
      strokeLine(c, [
        10 + Math.cos(a) * 5.8,
        10 + Math.sin(a) * 5.8,
        10 + Math.cos(a) * 7.6,
        10 + Math.sin(a) * 7.6,
      ]);
    }
  },
  moon: (c) => {
    c.beginPath();
    c.arc(10, 10, 6.2, 0.15, Math.PI * 2 - 1.68);
    c.arc(13, 7, 5, Math.PI * 2 - 2.45, 0.88, true);
    c.closePath();
    c.stroke();
  },
  refresh: (c) => {
    c.beginPath();
    c.arc(10, 10, 5.6, 0.22 * Math.PI, 1.82 * Math.PI);
    c.stroke();
    strokeLine(c, [15, 3.4, 15, 7.1, 11.3, 7.1]);
  },
  folder: (c) => {
    strokeLine(c, [
      2.5, 6, 2.5, 15, 3.5, 16, 16.5, 16, 17.5, 15, 17.5, 7.5, 16.5, 6.5, 9.5,
      6.5, 8, 4.5, 3.5, 4.5, 2.5, 6,
    ]);
  },
  "folder-open": (c) => {
    strokeLine(c, [
      2.5, 15, 2.5, 6, 3.5, 4.5, 8, 4.5, 9.5, 6.5, 15.5, 6.5, 16.5, 7.5, 16.5, 9,
    ]);
    strokeLine(c, [2.5, 15, 4.8, 9.5, 17.8, 9.5, 15.5, 16, 3.5, 16, 2.5, 15]);
  },
  file: (c) => {
    strokeLine(c, [5, 2.5, 11.5, 2.5, 15.5, 6.5, 15.5, 17.5, 5, 17.5, 5, 2.5]);
    strokeLine(c, [11.5, 2.5, 11.5, 6.5, 15.5, 6.5]);
  },
  code: (c) => {
    strokeLine(c, [7, 6.5, 3.5, 10, 7, 13.5]);
    strokeLine(c, [13, 6.5, 16.5, 10, 13, 13.5]);
  },
  diff: (c) => {
    strokeLine(c, [6, 4, 6, 10]);
    strokeLine(c, [3, 7, 9, 7]);
    strokeLine(c, [3, 14.5, 9, 14.5]);
    strokeLine(c, [13, 7, 17, 7]);
    strokeLine(c, [13, 14.5, 17, 14.5]);
  },
  "chevron-right": (c) => {
    strokeLine(c, [7.5, 5.5, 12, 10, 7.5, 14.5]);
  },
  "chevron-down": (c) => {
    strokeLine(c, [5.5, 7.5, 10, 12, 14.5, 7.5]);
  },
  close: (c) => {
    strokeLine(c, [6, 6, 14, 14]);
    strokeLine(c, [14, 6, 6, 14]);
  },
  plus: (c) => {
    strokeLine(c, [10, 4.5, 10, 15.5]);
    strokeLine(c, [4.5, 10, 15.5, 10]);
  },
  external: (c) => {
    strokeLine(c, [9, 4.5, 4.5, 4.5, 4.5, 15.5, 15.5, 15.5, 15.5, 11]);
    strokeLine(c, [11.5, 4, 16, 4, 16, 8.5]);
    strokeLine(c, [16, 4, 9.5, 10.5]);
  },
  branch: (c) => {
    strokeCircle(c, 6, 5.5, 1.8);
    strokeCircle(c, 6, 14.5, 1.8);
    strokeCircle(c, 14, 7.5, 1.8);
    strokeLine(c, [6, 7.3, 6, 12.7]);
    c.beginPath();
    c.moveTo(6, 11);
    c.quadraticCurveTo(14, 11, 14, 9.3);
    c.stroke();
  },
  send: (c) => {
    strokeLine(c, [14.5, 6.5, 14.5, 11.5, 5.5, 11.5]);
    strokeLine(c, [8.5, 8.5, 5.5, 11.5, 8.5, 14.5]);
  },
  play: (c) => {
    strokeLine(c, [6.5, 4.5, 15.5, 10, 6.5, 15.5, 6.5, 4.5]);
  },
  music: (c) => {
    strokeLine(c, [8, 14, 8, 5.5, 15.5, 4, 15.5, 12.5]);
    strokeCircle(c, 6.2, 14.2, 2);
    strokeCircle(c, 13.7, 12.7, 2);
  },
  "zoom-in": (c) => {
    strokeCircle(c, 8.8, 8.8, 4.8);
    strokeLine(c, [8.8, 6.8, 8.8, 10.8]);
    strokeLine(c, [6.8, 8.8, 10.8, 8.8]);
    strokeLine(c, [12.4, 12.4, 16.5, 16.5]);
  },
  "zoom-out": (c) => {
    strokeCircle(c, 8.8, 8.8, 4.8);
    strokeLine(c, [6.8, 8.8, 10.8, 8.8]);
    strokeLine(c, [12.4, 12.4, 16.5, 16.5]);
  },
  check: (c) => {
    strokeLine(c, [4.5, 10.5, 8.3, 14.2, 15.5, 6]);
  },
};

export function Icon(props: {
  name: IconName;
  size?: number;
  tint?: string | Accessor<string>;
  weight?: number;
}): JSX.Element {
  const size = props.size ?? 14;
  const weight = props.weight ?? 1.5;
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        const stroke =
          typeof props.tint === "function"
            ? props.tint()
            : (props.tint ?? "#85858b");
        cx.scale(width / 20, width / 20);
        cx.strokeStyle = stroke;
        cx.fillStyle = stroke;
        cx.lineWidth = weight;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        GLYPHS[props.name](cx);
      }}
    />
  );
}

interface BadgeSpec {
  glyph: string;
  color: string;
}

const EXT_BADGES: Record<string, BadgeSpec> = {
  md: { glyph: "M↓", color: "#519aba" },
  mdx: { glyph: "M↓", color: "#519aba" },
  mmd: { glyph: "M◇", color: "#2dd4bf" },
  mermaid: { glyph: "M◇", color: "#2dd4bf" },
  ts: { glyph: "TS", color: "#519aba" },
  tsx: { glyph: "TS", color: "#519aba" },
  js: { glyph: "JS", color: "#cbcb41" },
  jsx: { glyph: "JS", color: "#cbcb41" },
  json: { glyph: "{}", color: "#cbcb41" },
  jsonl: { glyph: "{}", color: "#cbcb41" },
  html: { glyph: "<>", color: "#e37933" },
  svg: { glyph: "SVG", color: "#fb923c" },
  csv: { glyph: "⊞", color: "#8dc149" },
  tsv: { glyph: "⊞", color: "#8dc149" },
  diff: { glyph: "±", color: "#e8ab53" },
  patch: { glyph: "±", color: "#e8ab53" },
  pdf: { glyph: "PDF", color: "#f87171" },
  png: { glyph: "IMG", color: "#c084fc" },
  jpg: { glyph: "IMG", color: "#c084fc" },
  jpeg: { glyph: "IMG", color: "#c084fc" },
  gif: { glyph: "IMG", color: "#c084fc" },
  webp: { glyph: "IMG", color: "#c084fc" },
  avif: { glyph: "IMG", color: "#c084fc" },
  heic: { glyph: "IMG", color: "#c084fc" },
  heif: { glyph: "IMG", color: "#c084fc" },
  bmp: { glyph: "IMG", color: "#c084fc" },
  ico: { glyph: "IMG", color: "#c084fc" },
  tiff: { glyph: "IMG", color: "#c084fc" },
  tif: { glyph: "IMG", color: "#c084fc" },
  icns: { glyph: "IMG", color: "#c084fc" },
  mp4: { glyph: "VID", color: "#f472b6" },
  mov: { glyph: "VID", color: "#f472b6" },
  webm: { glyph: "VID", color: "#f472b6" },
  m4v: { glyph: "VID", color: "#f472b6" },
  mkv: { glyph: "VID", color: "#f472b6" },
  avi: { glyph: "VID", color: "#f472b6" },
  mp3: { glyph: "AUD", color: "#38bdf8" },
  wav: { glyph: "AUD", color: "#38bdf8" },
  m4a: { glyph: "AUD", color: "#38bdf8" },
  aac: { glyph: "AUD", color: "#38bdf8" },
  flac: { glyph: "AUD", color: "#38bdf8" },
  ogg: { glyph: "AUD", color: "#38bdf8" },
  opus: { glyph: "AUD", color: "#38bdf8" },
  caf: { glyph: "AUD", color: "#38bdf8" },
  aiff: { glyph: "AUD", color: "#38bdf8" },
  aif: { glyph: "AUD", color: "#38bdf8" },
};

export function FileBadge(props: {
  name: string | Accessor<string>;
  color?: string | Accessor<string>;
}): JSX.Element {
  const spec = computed(() => {
    const raw = typeof props.name === "function" ? props.name() : props.name;
    const ext = raw.split(".").pop()?.toLowerCase() ?? "";
    return EXT_BADGES[ext] ?? { glyph: "≡", color: "#7a7a7a" };
  });
  const textColor = computed(() =>
    typeof props.color === "function" ? props.color() : props.color
  );
  return (
    <View class="w-5 items-center justify-center shrink-0">
      <Text
        style={textColor() ? { color: textColor() } : undefined}
        class="text-[10px] font-mono font-medium leading-none whitespace-nowrap text-muted-foreground"
      >
        {spec().glyph}
      </Text>
    </View>
  );
}

/** The app mark: a fountain pen nib and cursive flourish in the theme's `ink` and `accent` colors. */
export function AppLogo(props: {
  size?: number;
  ink?: Accessor<string>;
  accent?: Accessor<string>;
}): JSX.Element {
  const size = props.size ?? 48;
  const ink = props.ink ?? (() => "#141414");
  const accent = props.accent ?? (() => "#d7381e");
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 64, width / 64);
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.lineWidth = 3.6;
        cx.strokeStyle = ink();
        // Fountain pen nib body + slit
        strokeLine(cx, [44, 12, 52, 20, 36, 36, 18, 44, 26, 26, 44, 12]);
        strokeLine(cx, [18, 44, 30, 32]);
        // Ink flourish
        cx.strokeStyle = accent();
        strokeLine(cx, [18, 48, 28, 54, 42, 50, 50, 44]);
      }}
    />
  );
}
