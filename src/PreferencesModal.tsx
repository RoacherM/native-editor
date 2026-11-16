import * as path from "path";
import { computed, effect, signal, Text, View, type Accessor, type JSX, type Signal } from "nsh";
import { Button, Input } from "nsh/base";
import { unsavedQuestion, type UnsavedGuard as PendingUnsavedGuard } from "./session";
import type { ShellProfile } from "./TerminalPane";
import { EDITOR_THEMES, type EditorTheme } from "./themes";
import { ModalShell, SurfaceButton } from "./ui";

export const FONT_FAMILY_PRESETS = [
  "JetBrainsMono Nerd Font Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Fira Code",
  "Cascadia Code",
  "Courier New",
] as const;

function ThemeSwatchRow(props: {
  activeThemeId: Accessor<string>;
  onSelectTheme: (id: string) => void;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap gap-2">
      <Each of={EDITOR_THEMES} key={(t) => t.id}>
        {(t) => {
          const isSelected = () => props.activeThemeId() === t().id;
          return (
            <Button
              selected={isSelected()}
              testID={`theme-preset-${t().id}`}
              onPress={() => props.onSelectTheme(t().id)}
              style={{
                backgroundColor: t().ui.background,
                borderColor: isSelected() ? t().ui.accent : t().ui.border,
              }}
              class="h-7 px-3 rounded border flex-row items-center gap-2 shadow-none focus-visible:outline-2 focus-visible:outline-ring"
            >
              <View class="flex-row items-center gap-1">
                <View class="w-2 h-2 rounded-full" style={{ backgroundColor: t().syntax.keyword }} />
                <View class="w-2 h-2 rounded-full" style={{ backgroundColor: t().syntax.string }} />
                <View class="w-2 h-2 rounded-full" style={{ backgroundColor: t().syntax.function }} />
              </View>
              <Text
                style={{ color: t().ui.foreground }}
                class={`text-[11px] ${isSelected() ? "font-medium" : "font-normal"}`}
              >
                {t().name}
              </Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

function FontPresetList(props: {
  fontFamily: Accessor<string>;
  onSelect: (family: string) => void;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap gap-2 pt-1">
      <Each of={FONT_FAMILY_PRESETS} key={(f) => f}>
        {(preset) => {
          const active = () => props.fontFamily() === preset();
          return (
            <SurfaceButton
              size="sm"
              variant={active() ? "primary" : "secondary"}
              selected={active()}
              testID={`font-preset-${preset().split(/\s+/)[0]}`}
              onPress={() => props.onSelect(preset())}
            >
              <Text
                style={{ fontFamily: preset() }}
                class={`text-[11px] ${active() ? "font-medium text-primary-foreground" : "text-foreground"}`}
              >
                {preset()}
              </Text>
            </SurfaceButton>
          );
        }}
      </Each>
    </View>
  );
}

function ShellPresetList(props: {
  defaultShell: Accessor<string>;
  shells: Accessor<ShellProfile[]>;
  onSelect: (shellPath: string) => void;
}): JSX.Element {
  return (
    <View class="flex-row flex-wrap gap-2">
      <Each of={props.shells()} key={(s) => s.path}>
        {(sh) => {
          const active = () => props.defaultShell() === sh().path;
          return (
            <SurfaceButton
              size="sm"
              mono
              variant={active() ? "primary" : "secondary"}
              selected={active()}
              label={`${sh().name} (${sh().path})`}
              testID={`shell-preset-${sh().name}`}
              onPress={() => props.onSelect(sh().path)}
            />
          );
        }}
      </Each>
    </View>
  );
}

export interface PreferencesModalProps {
  open: Signal<boolean>;
  fontFamily: Signal<string>;
  fontSize: Signal<number>;
  themeId: Accessor<string>;
  theme: Accessor<EditorTheme>;
  defaultShell: Signal<string>;
  shells: Accessor<ShellProfile[]>;
  onSetTheme: (id: string) => void;
  onSetFamily: (family: string) => void;
  onAdjustSize: (delta: number) => void;
  onSetShell: (shellPath: string) => void;
  onReset: () => void;
}

export function PreferencesModal(props: PreferencesModalProps): JSX.Element {
  return (
    <ModalShell
      open={props.open}
      title="Preferences"
      testID="font-settings-dialog"
      closeTestID="font-dialog-close"
      closeAccessibilityLabel="Close preferences"
    >
      <View class="gap-2">
        <Text class="text-xs text-muted-foreground">Color theme</Text>
        <ThemeSwatchRow activeThemeId={props.themeId} onSelectTheme={props.onSetTheme} />
      </View>

      <View class="gap-2">
        <Text class="text-xs text-muted-foreground">Font family</Text>
        <Input
          testID="font-family-input"
          value={props.fontFamily()}
          onChange={({ value }) => props.onSetFamily(value)}
          placeholder="Font family"
          style={{
            height: 28,
            fontFamily: props.fontFamily() || undefined,
            backgroundColor: props.theme().ui.background,
            color: props.theme().ui.foreground,
          }}
          class="w-full h-7 px-3 text-xs font-mono rounded border-none"
        />
        <FontPresetList fontFamily={props.fontFamily} onSelect={props.onSetFamily} />
      </View>

      <View class="flex-row items-center justify-between pt-1">
        <Text class="text-xs text-muted-foreground">Font size</Text>
        <View class="flex-row items-center gap-2">
          <SurfaceButton
            size="sm"
            variant="secondary"
            mono
            label="-"
            testID="font-size-dec"
            accessibilityLabel="Decrease font size"
            onPress={() => props.onAdjustSize(-1)}
            class="w-6 px-0"
          />
          <Text
            testID="font-size-value"
            class="w-12 text-center text-xs font-mono tabular-nums text-foreground"
          >
            {`${props.fontSize()}px`}
          </Text>
          <SurfaceButton
            size="sm"
            variant="secondary"
            mono
            label="+"
            testID="font-size-inc"
            accessibilityLabel="Increase font size"
            onPress={() => props.onAdjustSize(1)}
            class="w-6 px-0"
          />
          <SurfaceButton
            size="sm"
            variant="secondary"
            label="Reset"
            testID="font-reset-btn"
            onPress={props.onReset}
            class="ml-1"
          />
        </View>
      </View>

      <View class="gap-2 pt-1">
        <Text class="text-xs text-muted-foreground">Terminal shell</Text>
        <ShellPresetList
          defaultShell={props.defaultShell}
          shells={props.shells}
          onSelect={props.onSetShell}
        />
      </View>

      <View class="p-3 rounded bg-background">
        <Text
          style={{
            fontFamily: props.fontFamily() || undefined,
            fontSize: props.fontSize(),
          }}
          class="font-mono text-foreground"
        >
          {"const greeting = () => '0O1lI != === =>';"}
        </Text>
      </View>
    </ModalShell>
  );
}

function formatGuardQuestion(guard: PendingUnsavedGuard): string {
  const names = guard.dirtyPaths.map((p) => path.basename(p) || p).join(", ");
  return unsavedQuestion(guard.action, names);
}

export interface UnsavedChangesDialogProps {
  pending: Signal<PendingUnsavedGuard | null>;
  onSaveAndProceed: (guard: PendingUnsavedGuard) => void;
  onDiscardAndProceed: (guard: PendingUnsavedGuard) => void;
}

export function UnsavedChangesDialog(props: UnsavedChangesDialogProps): JSX.Element {
  const isOpen = computed(() => props.pending() !== null);
  const lastQuestion = signal("");
  effect(() => {
    const cur = props.pending();
    if (cur) lastQuestion.set(formatGuardQuestion(cur));
  });

  return (
    <ModalShell
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) props.pending.set(null);
      }}
      title="Unsaved changes"
      testID="unsaved-changes-dialog"
      widthClass="w-[400px]"
      topOffsetClass="pt-24"
    >
      <Text class="text-xs text-muted-foreground">{lastQuestion()}</Text>
      <View class="flex-row items-center justify-end gap-2 pt-1">
        <SurfaceButton
          variant="secondary"
          label="Cancel"
          testID="unsaved-cancel-btn"
          onPress={() => props.pending.set(null)}
        />
        <SurfaceButton
          variant="secondary"
          label="Don't Save"
          testID="unsaved-discard-btn"
          onPress={() => {
            const cur = props.pending();
            if (cur) props.onDiscardAndProceed(cur);
          }}
        />
        <SurfaceButton
          variant="primary"
          label="Save"
          testID="unsaved-save-btn"
          onPress={() => {
            const cur = props.pending();
            if (cur) props.onSaveAndProceed(cur);
          }}
        />
      </View>
    </ModalShell>
  );
}
