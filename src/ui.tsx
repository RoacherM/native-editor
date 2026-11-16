import * as path from "path";
import { computed, keymap, Scroll, signal, Text, token, View, type Accessor, type JSX, type Signal } from "nsh";
import { Button, Dialog, Tab, Tabs, Tooltip } from "nsh/base";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-ring";
const VARIANT_BOX: Record<ButtonVariant, string> = {
  primary: "bg-primary hover:opacity-90 active:opacity-80",
  secondary: "bg-sidebar hover:opacity-90 active:opacity-80",
  ghost: "bg-transparent hover:bg-foreground/10 active:bg-foreground/15 selected:bg-background",
};

function renderTooltip(text?: string): JSX.Element | undefined {
  return text ? <Tooltip class="rounded bg-popover px-2 py-1 shadow-lg"><Text class="text-[11px] text-popover-foreground">{text}</Text></Tooltip> : undefined;
}

function surfaceTextClass(variant: ButtonVariant, selected?: boolean): string {
  if (variant === "primary") return "text-primary-foreground font-medium";
  if (variant === "secondary") return "text-foreground";
  return selected ? "text-foreground font-medium" : "text-muted-foreground";
}

function iconTintColor(variant: ButtonVariant, selected?: boolean): string {
  if (variant === "primary") return token("primary-foreground");
  return variant === "secondary" || selected ? token("foreground") : token("muted-foreground");
}

export interface SurfaceButtonProps {
  variant?: ButtonVariant; size?: ButtonSize; label?: string; mono?: boolean;
  selected?: boolean; disabled?: boolean; testID?: string; accessibilityLabel?: string;
  tooltip?: string; class?: string; onPress?: () => void; children?: JSX.Element;
}

export function SurfaceButton(props: SurfaceButtonProps): JSX.Element {
  const variant = () => props.variant ?? "secondary";
  const boxSize = () => (props.size === "sm" ? "h-6 px-2.5" : "h-7 px-3");
  const textSize = () => (props.size === "sm" ? "text-[11px]" : "text-xs");
  return (
    <Button selected={props.selected} disabled={props.disabled} testID={props.testID} accessibilityLabel={props.accessibilityLabel} tooltip={renderTooltip(props.tooltip)} onPress={props.onPress} class={`rounded flex-row items-center justify-center gap-1.5 border-none shadow-none select-none disabled:opacity-45 ${FOCUS_RING} ${boxSize()} ${VARIANT_BOX[variant()]} ${props.class ?? ""}`}>
      {props.children ?? <Text class={`${textSize()} ${props.mono ? "font-mono " : ""}${surfaceTextClass(variant(), props.selected)}`}>{props.label ?? ""}</Text>}
    </Button>
  );
}

export interface IconButtonProps {
  icon: IconName; accessibilityLabel: string; variant?: ButtonVariant; iconSize?: number;
  selected?: boolean; disabled?: boolean; testID?: string; tooltip?: string;
  class?: string; onPress?: () => void;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const variant = () => props.variant ?? "ghost";
  return (
    <Button hitSlop={4} selected={props.selected} disabled={props.disabled} testID={props.testID} accessibilityLabel={props.accessibilityLabel} tooltip={renderTooltip(props.tooltip)} onPress={props.onPress} class={`h-6 w-6 p-0 rounded items-center justify-center shrink-0 border-none shadow-none select-none disabled:opacity-45 ${FOCUS_RING} ${VARIANT_BOX[variant()]} ${props.class ?? ""}`}>
      <Icon name={props.icon} size={props.iconSize ?? 14} tint={() => iconTintColor(variant(), props.selected)} />
    </Button>
  );
}

function countBasenames(paths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const base = path.basename(p) || p;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return counts;
}

/** Computes `path -> parentDir` only for tabs whose basename collides with another open tab. */
export function disambiguateTabParents(paths: readonly string[]): Record<string, string> {
  const counts = countBasenames(paths);
  const out: Record<string, string> = {};
  for (const p of paths) {
    const base = path.basename(p) || p;
    const parent = (counts.get(base) ?? 0) > 1 ? path.basename(path.dirname(p)) : "";
    if (parent && parent !== ".") out[p] = parent;
  }
  return out;
}

export interface TabStripProps<T> {
  items: readonly T[]; activeId: string | number | null;
  getId: (item: T) => string | number; getLabel: (item: T) => string;
  getPath?: (item: T) => string; getTestKey?: (item: T) => string | number;
  isDirty?: (item: T) => boolean; leading?: (item: T) => JSX.Element; trailing?: JSX.Element;
  selectTestIdPrefix?: string; closeTestIdPrefix?: string; heightClass?: string;
  mono?: boolean; testID?: string; class?: string;
  onSelect: (id: string | number, item: T) => void;
  onClose?: (id: string | number, item: T) => void;
}

function TabTrailingSlot(props: { dirty: boolean; label: string; testID: string; onClose: () => void }): JSX.Element {
  return (
    <Button hitSlop={4} testID={props.testID} accessibilityLabel={`Close ${props.label}`} onPress={props.onClose} class={`group relative h-4 w-4 p-0 shrink-0 rounded items-center justify-center bg-transparent hover:bg-foreground/10 active:bg-foreground/15 border-none shadow-none ${FOCUS_RING}`}>
      <If when={props.dirty} else={<Icon name="close" size={10} tint={() => token("muted-foreground")} />}>
        <View class="relative h-4 w-4 items-center justify-center">
          <Text class="text-xs font-medium leading-none text-primary group-hover:opacity-0">•</Text>
          <View class="absolute inset-0 items-center justify-center opacity-0 group-hover:opacity-100">
            <Icon name="close" size={10} tint={() => token("muted-foreground")} />
          </View>
        </View>
      </If>
    </Button>
  );
}

function resolveTabMeta<T>(item: T, strip: TabStripProps<T>, parents: Record<string, string>) {
  const id = strip.getId(item);
  const label = strip.getLabel(item);
  const testKey = strip.getTestKey ? strip.getTestKey(item) : label;
  const parentHint = strip.getPath ? parents[strip.getPath(item)] : undefined;
  return { id, label, testKey, parentHint };
}

function TabStripChip<T>(props: { item: Accessor<T>; strip: TabStripProps<T>; height: Accessor<string>; parents: Accessor<Record<string, string>> }): JSX.Element {
  const meta = computed(() => resolveTabMeta(props.item(), props.strip, props.parents()));
  const isActive = () => meta().id === props.strip.activeId;
  const selectPrefix = () => props.strip.selectTestIdPrefix ?? "tab-select";
  const closePrefix = () => props.strip.closeTestIdPrefix ?? "tab-close";
  return (
    <View class={`relative px-3 flex-row items-center gap-1.5 shrink-0 ${props.height()} ${isActive() ? "bg-background" : "bg-transparent"}`}>
      <If when={isActive()}><View class="absolute inset-x-0 top-0 h-[2px] bg-primary" /></If>
      <Tab selected={isActive()} testID={`${selectPrefix()}-${meta().testKey}`} onPress={() => props.strip.onSelect(meta().id, props.item())} class={`h-full flex-row items-center gap-1.5 min-w-0 ${FOCUS_RING}`}>
        {props.strip.leading?.(props.item())}
        <Text class={`max-w-[160px] truncate text-xs ${props.strip.mono ? "font-mono " : ""}${isActive() ? "font-medium text-foreground" : "font-normal text-muted-foreground"}`}>
          <If when={meta().parentHint}>{(dir) => <Text class="font-normal text-muted-foreground">{`${dir()}/`}</Text>}</If>
          {meta().label}
        </Text>
      </Tab>
      <If when={props.strip.onClose !== undefined}>
        <TabTrailingSlot dirty={Boolean(props.strip.isDirty?.(props.item()))} label={meta().label} testID={`${closePrefix()}-${meta().testKey}`} onClose={() => props.strip.onClose?.(meta().id, props.item())} />
      </If>
    </View>
  );
}

export function TabStrip<T>(props: TabStripProps<T>): JSX.Element {
  const height = () => props.heightClass ?? "h-9";
  const parents = computed(() => (props.getPath ? disambiguateTabParents(props.items.map((it) => props.getPath!(it))) : {}));
  return (
    <View testID={props.testID} class={`flex-row items-center bg-sidebar select-none shrink-0 ${height()} ${props.class ?? ""}`}>
      <Scroll horizontal class="flex-1 shrink min-w-0">
        <Tabs class={`flex-row items-stretch ${height()}`}>
          <Each of={props.items} key={(item) => String(props.getId(item))}>
            {(item) => <TabStripChip item={item} strip={props} height={height} parents={parents} />}
          </Each>
        </Tabs>
      </Scroll>
      {props.trailing}
    </View>
  );
}

export interface SegmentedItem<T extends string> {
  value: T; label?: string; icon?: IconName; accessibilityLabel?: string; tooltip?: string; testID?: string;
}

export interface SegmentedControlProps<T extends string> {
  items: readonly SegmentedItem<T>[]; value: T; onChange: (value: T) => void; testID?: string; class?: string;
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>): JSX.Element {
  return (
    <View testID={props.testID} class={`flex-row items-center rounded p-0.5 gap-0.5 bg-sidebar shrink-0 select-none ${props.class ?? ""}`}>
      <Each of={props.items} key={(it) => it.value}>
        {(item) => {
          const active = () => props.value === item().value;
          return (
            <Button role="tab" selected={active()} testID={item().testID} accessibilityLabel={item().accessibilityLabel} tooltip={renderTooltip(item().tooltip)} onPress={() => props.onChange(item().value)} class={`h-5 px-2 rounded-sm flex-row items-center justify-center gap-1 border-none shadow-none ${FOCUS_RING} ${active() ? "bg-background" : "bg-transparent hover:opacity-85"}`}>
              <If when={item().icon}>{(ic) => <Icon name={ic()} size={12} tint={() => (active() ? token("foreground") : token("muted-foreground"))} />}</If>
              <If when={item().label}>{(lbl) => <Text class={`text-[11px] ${active() ? "font-medium text-foreground" : "font-normal text-muted-foreground"}`}>{lbl()}</Text>}</If>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

export interface ZoomState {
  value: Signal<number>; zoomIn: () => void; zoomOut: () => void; reset: () => void;
  canZoomIn: Accessor<boolean>; canZoomOut: Accessor<boolean>; percentLabel: Accessor<string>;
}

export function createZoom(min = 25, max = 400, step = 25, initial = 100): ZoomState {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const value = signal(clamp(initial));
  const scale = max <= 10 ? 100 : 1;
  return {
    value,
    zoomIn: () => value.update((z) => clamp(z + step)),
    zoomOut: () => value.update((z) => clamp(z - step)),
    reset: () => value.set(clamp(initial)),
    canZoomIn: computed(() => value() < max),
    canZoomOut: computed(() => value() > min),
    percentLabel: computed(() => `${Math.round(value() * scale)}%`),
  };
}

export interface ViewportPillProps {
  meta?: string; zoom?: ZoomState; zoomTestIdPrefix?: string; testID?: string; class?: string; children?: JSX.Element;
}

export function ViewportPill(props: ViewportPillProps): JSX.Element {
  const zoomId = (s: string) => (props.zoomTestIdPrefix ? `${props.zoomTestIdPrefix}-${s}` : s);
  return (
    <View testID={props.testID} class={`absolute bottom-3 right-4 h-7 px-2 rounded-md shadow-lg bg-card flex-row items-center gap-1 select-none ${props.class ?? ""}`}>
      <If when={props.meta}>{(meta) => <Text class="text-[11px] font-mono text-muted-foreground px-1">{meta()}</Text>}</If>
      <If when={props.zoom}>
        {(z) => (
          <View class="flex-row items-center gap-0.5">
            <IconButton icon="zoom-out" iconSize={12} accessibilityLabel="Zoom out" disabled={!z().canZoomOut()} testID={zoomId("zoom-out")} onPress={z().zoomOut} />
            <SurfaceButton variant="ghost" size="sm" mono label={z().percentLabel()} testID={zoomId("zoom-reset")} onPress={z().reset} class="px-1.5" />
            <IconButton icon="zoom-in" iconSize={12} accessibilityLabel="Zoom in" disabled={!z().canZoomIn()} testID={zoomId("zoom-in")} onPress={z().zoomIn} />
          </View>
        )}
      </If>
      {props.children}
    </View>
  );
}

export type NoticeKind = "saveError" | "diskConflict" | "diskMissing" | "openError" | "readOnly";
export interface NoticeAction { testID: string; label: string; variant: "primary" | "secondary"; onPress?: () => void }
export interface ResolvedNotice { kind: NoticeKind; testID: string; message: string; muted?: boolean; actions: NoticeAction[] }

export interface NoticeBannerProps {
  fileName?: string; saveError?: string | null; diskConflict?: boolean; diskMissing?: boolean;
  openError?: string | null; readOnly?: string | null;
  onDismissSaveError?: () => void; onResolveConflict?: (choice: "reload" | "keep") => void;
  onCloseMissing?: () => void; onSaveAsMissing?: () => void; onDismissOpenError?: () => void;
}

function resolveCriticalNotice(state: NoticeBannerProps, name: string): ResolvedNotice | null {
  if (state.saveError) return { kind: "saveError", testID: "save-error-banner", message: state.saveError, actions: [{ testID: "save-error-dismiss-btn", label: "Dismiss", variant: "secondary", onPress: state.onDismissSaveError }] };
  if (state.diskConflict) return { kind: "diskConflict", testID: "disk-conflict-banner", message: `${name} changed on disk. Your edits are not saved yet.`, actions: [{ testID: "disk-conflict-keep-btn", label: "Keep My Edits", variant: "secondary", onPress: () => state.onResolveConflict?.("keep") }, { testID: "disk-conflict-reload-btn", label: "Reload from Disk", variant: "primary", onPress: () => state.onResolveConflict?.("reload") }] };
  if (state.diskMissing) return { kind: "diskMissing", testID: "file-missing-banner", message: `${name} was moved or deleted.`, actions: [{ testID: "file-missing-close-btn", label: "Close", variant: "secondary", onPress: state.onCloseMissing }, { testID: "file-missing-save-as-btn", label: "Save As…", variant: "primary", onPress: state.onSaveAsMissing }] };
  return null;
}

/** Single-slot priority arbiter: `saveError > diskConflict > diskMissing > openError > readOnly`. */
export function resolveNotice(state: NoticeBannerProps): ResolvedNotice | null {
  const critical = resolveCriticalNotice(state, state.fileName ?? "");
  if (critical) return critical;
  if (state.openError) return { kind: "openError", testID: "open-error-banner", message: state.openError, actions: [{ testID: "open-error-dismiss-btn", label: "Dismiss", variant: "secondary", onPress: state.onDismissOpenError }] };
  if (state.readOnly) return { kind: "readOnly", testID: "read-only-banner", message: state.readOnly, muted: true, actions: [] };
  return null;
}

export function NoticeBanner(props: NoticeBannerProps): JSX.Element {
  const active = computed(() => resolveNotice(props));
  return (
    <If when={active()}>
      {(notice) => (
        <View testID={notice().testID} class="h-9 px-3 flex-row items-center gap-3 bg-card select-none shrink-0">
          <If when={!notice().muted}><View class="w-1.5 h-1.5 rounded-full bg-primary shrink-0" /></If>
          <Text class={`flex-1 text-xs truncate ${notice().muted ? "text-muted-foreground" : "text-foreground"}`}>{notice().message}</Text>
          <Each of={notice().actions} key={(act) => act.testID}>
            {(act) => <SurfaceButton size="sm" variant={act().variant} label={act().label} testID={act().testID} onPress={act().onPress} />}
          </Each>
        </View>
      )}
    </If>
  );
}

export interface ModalShellProps {
  open: boolean | Accessor<boolean> | Signal<boolean>; onOpenChange?: (open: boolean) => void;
  title?: string; testID?: string; closeTestID?: string; closeAccessibilityLabel?: string;
  widthClass?: string; topOffsetClass?: string; children?: JSX.Element;
}

function readModalOpen(open: ModalShellProps["open"]): boolean {
  return typeof open === "function" ? open() : open;
}

function writeModalOpen(props: ModalShellProps, next: boolean): void {
  if (props.onOpenChange) props.onOpenChange(next);
  else if (typeof props.open === "function" && "set" in props.open) props.open.set(next);
}

export function ModalShell(props: ModalShellProps): JSX.Element {
  return (
    <Dialog open={readModalOpen(props.open)} animation="fade" closeOnEscape closeOnBackdropPress onCancel={() => writeModalOpen(props, false)} onOpenChange={({ open }) => writeModalOpen(props, open)} backdropClass="bg-black/45" class={`items-center justify-start ${props.topOffsetClass ?? "pt-16"}`}>
      <View testID={props.testID} class={`${props.widthClass ?? "w-[480px]"} max-w-[92%] rounded-lg bg-card p-5 shadow-2xl gap-4 select-none`}>
        <If when={props.title}>
          {(title) => (
            <View class="flex-row items-center justify-between">
              <Text class="text-sm font-medium text-foreground">{title()}</Text>
              <If when={Boolean(props.closeTestID || props.closeAccessibilityLabel)}>
                <IconButton icon="close" iconSize={12} testID={props.closeTestID} accessibilityLabel={props.closeAccessibilityLabel ?? `Close ${title().toLowerCase()}`} onPress={() => writeModalOpen(props, false)} />
              </If>
            </View>
          )}
        </If>
        {props.children}
      </View>
    </Dialog>
  );
}

export function formatShortcut(shortcut: string): string {
  if (!shortcut) return "";
  try {
    return keymap.label(shortcut);
  } catch {
    return shortcut;
  }
}

export function Keycap(props: { shortcut: string; testID?: string; class?: string }): JSX.Element {
  return (
    <View testID={props.testID} class={`h-5 px-1.5 rounded border border-border bg-sidebar items-center justify-center shrink-0 ${props.class ?? ""}`}>
      <Text class="text-[11px] font-mono leading-none text-muted-foreground">{formatShortcut(props.shortcut)}</Text>
    </View>
  );
}
