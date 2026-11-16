import {
  Canvas,
  computed,
  Text,
  token,
  View,
  type Accessor,
  type CanvasRenderingContext2D,
  type JSX,
} from "nsh";
import { badgeForPath } from "./classify";

export type IconName =
  | "sidebar"
  | "panel-bottom"
  | "files"
  | "search"
  | "diff"
  | "chevron-right"
  | "chevron-down"
  | "close"
  | "plus"
  | "branch"
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
  search: (c) => {
    strokeCircle(c, 8.8, 8.8, 4.8);
    strokeLine(c, [12.4, 12.4, 16.5, 16.5]);
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

/** Keeps the drawn screen stroke constant across 10pt, 12pt, 14pt, and 20pt icons. */
export function opticalStrokeWidth(width: number, strokeWeight = 1.35): number {
  return width > 0 ? strokeWeight * (20 / width) : strokeWeight;
}

export function Icon(props: {
  name: IconName;
  size?: number;
  tint?: string | Accessor<string>;
  weight?: number;
}): JSX.Element {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size ?? 14, height: props.size ?? 14 }}
      draw={(cx, { width }) => {
        if (width <= 0) return;
        const stroke =
          typeof props.tint === "function"
            ? props.tint()
            : (props.tint ?? token("muted-foreground"));
        cx.scale(width / 20, width / 20);
        cx.strokeStyle = stroke;
        cx.fillStyle = stroke;
        cx.lineWidth = opticalStrokeWidth(width, props.weight ?? 1.35);
        cx.lineCap = "round";
        cx.lineJoin = "round";
        GLYPHS[props.name](cx);
      }}
    />
  );
}

export function FileBadge(props: {
  name: string | Accessor<string>;
  color?: string | Accessor<string>;
}): JSX.Element {
  const glyph = computed(() => {
    const raw = typeof props.name === "function" ? props.name() : props.name;
    return badgeForPath(raw);
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
        {glyph()}
      </Text>
    </View>
  );
}
