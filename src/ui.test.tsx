import { mount, signal, Text, token, View, type JSX } from "nsh";
import { describe, expect, test } from "nsh/test";
import { badgeForPath } from "./classify";
import * as iconsMod from "./icons";
import { FileBadge, Icon, opticalStrokeWidth } from "./icons";
import { EDITOR_THEMES, getThemeById, syncThemeTokens } from "./themes";
import {
  createZoom,
  disambiguateTabParents,
  formatShortcut,
  IconButton,
  Keycap,
  ModalShell,
  NoticeBanner,
  resolveNotice,
  SegmentedControl,
  SurfaceButton,
  TabStrip,
  ViewportPill,
} from "./ui";

interface DemoTab {
  id: string;
  label: string;
  path: string;
  dirty: boolean;
}

describe("L2 Industrial UI & Icon pure unit contracts", () => {
  test("opticalStrokeWidth maintains constant 1.35pt screen stroke across 10pt–20pt and dead assets are removed", () => {
    for (const size of [10, 12, 14, 16, 20]) {
      const lineW = opticalStrokeWidth(size, 1.35);
      expect(Math.abs(lineW * (size / 20) - 1.35)).toBeLessThan(1e-9);
    }
    expect(opticalStrokeWidth(0, 1.35)).toBe(1.35);
    expect("AppLogo" in iconsMod).toBe(false);
  });

  test("badgeForPath gives monochrome ≡ to extensionless ts/pdf and proper glyphs to real extensions", () => {
    expect(badgeForPath("ts")).toBe("≡");
    expect(badgeForPath("pdf")).toBe("≡");
    expect(badgeForPath("main.ts")).toBe("TS");
    expect(badgeForPath("report.pdf")).toBe("PDF");
  });

  test("disambiguateTabParents adds parent/ only when two tabs share a basename", () => {
    expect(disambiguateTabParents(["/w/a/main.ts", "/w/b/README.md"])).toEqual({});
    expect(
      disambiguateTabParents(["/w/web/index.ts", "/w/api/index.ts", "/w/README.md"])
    ).toEqual({
      "/w/web/index.ts": "web",
      "/w/api/index.ts": "api",
    });
  });

  test("createZoom clamps min/max, steps cleanly, and supports both percentage and ratio scales", () => {
    const z = createZoom(50, 150, 25, 100);
    expect(z.percentLabel()).toBe("100%");
    z.zoomIn();
    expect(z.percentLabel()).toBe("125%");
    z.zoomIn();
    z.zoomIn();
    expect(z.value()).toBe(150);
    expect(z.canZoomIn()).toBe(false);
    z.reset();
    expect(z.value()).toBe(100);
    z.zoomOut();
    z.zoomOut();
    z.zoomOut();
    expect(z.value()).toBe(50);
    expect(z.canZoomOut()).toBe(false);

    const ratioZoom = createZoom(0.5, 2, 0.25, 1);
    expect(ratioZoom.percentLabel()).toBe("100%");
    ratioZoom.zoomIn();
    expect(ratioZoom.percentLabel()).toBe("125%");
  });

  test("resolveNotice strictly enforces saveError > diskConflict > diskMissing > openError > readOnly and fires callbacks", () => {
    let resolvedChoice = "";
    let dismissedSave = false;
    let closedMissing = false;
    let savedAsMissing = false;
    let dismissedOpen = false;

    const full = {
      fileName: "a.ts",
      saveError: "EACCES",
      diskConflict: true,
      diskMissing: true,
      openError: "ENOENT",
      readOnly: "Read-only",
      onDismissSaveError: () => {
        dismissedSave = true;
      },
      onResolveConflict: (choice: "reload" | "keep") => {
        resolvedChoice = choice;
      },
      onCloseMissing: () => {
        closedMissing = true;
      },
      onSaveAsMissing: () => {
        savedAsMissing = true;
      },
      onDismissOpenError: () => {
        dismissedOpen = true;
      },
    };

    const s1 = resolveNotice(full)!;
    expect(s1.testID).toBe("save-error-banner");
    s1.actions[0].onPress?.();
    expect(dismissedSave).toBe(true);

    const s2 = resolveNotice({ ...full, saveError: null })!;
    expect(s2.testID).toBe("disk-conflict-banner");
    expect(s2.actions.map((a) => a.testID)).toEqual([
      "disk-conflict-keep-btn",
      "disk-conflict-reload-btn",
    ]);
    s2.actions[0].onPress?.();
    expect(resolvedChoice).toBe("keep");
    s2.actions[1].onPress?.();
    expect(resolvedChoice).toBe("reload");

    const s3 = resolveNotice({ ...full, saveError: null, diskConflict: false })!;
    expect(s3.testID).toBe("file-missing-banner");
    expect(s3.actions.map((a) => a.testID)).toEqual([
      "file-missing-close-btn",
      "file-missing-save-as-btn",
    ]);
    s3.actions[0].onPress?.();
    s3.actions[1].onPress?.();
    expect(closedMissing).toBe(true);
    expect(savedAsMissing).toBe(true);

    const s4 = resolveNotice({
      ...full,
      saveError: null,
      diskConflict: false,
      diskMissing: false,
    })!;
    expect(s4.testID).toBe("open-error-banner");
    s4.actions[0].onPress?.();
    expect(dismissedOpen).toBe(true);

    const s5 = resolveNotice({
      ...full,
      saveError: null,
      diskConflict: false,
      diskMissing: false,
      openError: null,
    })!;
    expect(s5.testID).toBe("read-only-banner");
    expect(s5.muted).toBe(true);
    expect(s5.actions).toEqual([]);

    expect(resolveNotice({})).toBeNull();
  });

  test("formatShortcut formats keystrokes via keymap.label and falls back on preformatted strings", () => {
    expect(formatShortcut("mod+p").length).toBeGreaterThan(0);
    expect(formatShortcut("⌘⇧W")).toBe("⌘⇧W");
    expect(formatShortcut("")).toBe("");
  });
});

describe("L2 Industrial UI headless mount & reactive state transitions", () => {
  test("mounts all L2 primitives and drives reactive tab, segment, zoom, banner, modal, and theme transitions", async () => {
    const mode = signal<"preview" | "source" | "diff">("preview");
    const zoom = createZoom(25, 400, 25, 100);
    const modalOpen = signal(false);
    const tabs = signal<DemoTab[]>([
      { id: "/w/web/index.ts", label: "index.ts", path: "/w/web/index.ts", dirty: false },
      { id: "/w/api/index.ts", label: "index.ts", path: "/w/api/index.ts", dirty: true },
    ]);
    const activeTab = signal<string>("/w/web/index.ts");
    const saveErr = signal<string | null>("EACCES");
    const conflict = signal(true);
    const missing = signal(true);
    const openErr = signal<string | null>("ENOENT");
    const readOnly = signal<string | null>("Read-only");

    function Harness(): JSX.Element {
      return (
        <View class="flex-1 bg-background">
          <TabStrip
            testID="demo-tabs"
            items={tabs()}
            activeId={activeTab()}
            getId={(t) => t.id}
            getLabel={(t) => t.label}
            getPath={(t) => t.path}
            isDirty={(t) => t.dirty}
            selectTestIdPrefix="terminal-tab"
            closeTestIdPrefix="terminal-tab-close"
            leading={(t) => <FileBadge name={t.path} />}
            trailing={
              <IconButton
                icon="plus"
                iconSize={12}
                testID="terminal-add-btn"
                accessibilityLabel="New terminal tab"
              />
            }
            onSelect={(id) => activeTab.set(String(id))}
            onClose={(id) => tabs.update((l) => l.filter((x) => x.id !== String(id)))}
          />
          <NoticeBanner
            fileName="index.ts"
            saveError={saveErr()}
            diskConflict={conflict()}
            diskMissing={missing()}
            openError={openErr()}
            readOnly={readOnly()}
          />
          <View class="flex-row items-center gap-2 p-2">
            <SurfaceButton variant="primary" label="Save" tooltip="Save file" />
            <SurfaceButton variant="secondary" size="sm" label="Cancel" />
            <SurfaceButton variant="ghost" selected label="Ghost" />
            <IconButton icon="diff" accessibilityLabel="Show changed files" tooltip="Changed" />
            <FileBadge name="ts" />
            <Icon name="sidebar" size={12} />
            <Keycap shortcut="mod+p" />
            <SegmentedControl
              value={mode()}
              onChange={(m) => mode.set(m)}
              items={[
                { value: "preview", label: "Preview", testID: "mode-preview" },
                { value: "source", label: "Code", testID: "mode-source" },
                { value: "diff", label: "Diff", icon: "diff", testID: "mode-diff" },
              ]}
            />
          </View>
          <ViewportPill meta="320 × 180" zoom={zoom} zoomTestIdPrefix="image" />
          <ModalShell
            open={modalOpen}
            title="Preferences"
            testID="font-settings-dialog"
            closeTestID="font-dialog-close"
            closeAccessibilityLabel="Close preferences"
          >
            <Text>{`Active:${token("primary")}`}</Text>
          </ModalShell>
        </View>
      );
    }

    const unmount = mount(Harness);
    try {
      // Drive reactive transitions across all mounted primitives
      mode.set("diff");
      zoom.zoomIn();
      zoom.reset();
      tabs.update((list) => [
        { ...list[0], dirty: true },
        list[1],
        { id: "/w/README.md", label: "README.md", path: "/w/README.md", dirty: false },
      ]);
      activeTab.set("/w/api/index.ts");

      // Cascade NoticeBanner through all 5 priority levels down to null
      saveErr.set(null);
      conflict.set(false);
      missing.set(false);
      openErr.set(null);
      readOnly.set(null);

      // Modal open -> close without <If> teardown
      modalOpen.set(true);
      modalOpen.set(false);

      // Exercise syncThemeTokens across all 8 themes
      for (const theme of EDITOR_THEMES) {
        await syncThemeTokens(theme);
      }
      await syncThemeTokens(getThemeById("industrial-paper"));
    } finally {
      unmount();
    }
  });
});
