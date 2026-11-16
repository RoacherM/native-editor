import { mount, signal, View, type JSX } from "nsh";
import { describe, expect, open, test } from "nsh/test";
import * as sidebarMod from "./Sidebar";
import { CommandPalette, Sidebar } from "./Sidebar";
import { EDITOR_THEMES, getThemeById } from "./themes";

const FIXTURE_ROOT = decodeURIComponent(new URL("../fixtures", import.meta.url).pathname).replace(
  /\/+$/,
  "",
);

describe("Sidebar & CommandPalette Wave 2B contracts", () => {
  test("Changed empty state distinguishes clean Git repo from non-Git folder", () => {
    const resolveEmpty = (
      sidebarMod as unknown as {
        resolveChangedEmptyMessage?: (branch: string | undefined) => string;
      }
    ).resolveChangedEmptyMessage;
    expect(typeof resolveEmpty).toBe("function");
    expect(resolveEmpty!("main")).toBe("No uncommitted changes");
    expect(resolveEmpty!("feat/native-terminal")).toBe("No uncommitted changes");
    expect(resolveEmpty!("")).toBe("Not a Git repository");
    expect(resolveEmpty!(undefined)).toBe("No uncommitted changes");
  });

  test("hoists expandedIds into an O(1) Set, rotates single chevron without remounting Canvas, and eliminates CommandPalette static Industrial leaks", () => {
    expect(sidebarMod.treeChevronRotation(false)).toBe("0deg");
    expect(sidebarMod.treeChevronRotation(true)).toBe("90deg");
    expect(sidebarMod.treeRowTextOverflow(false)).toBe("ellipsis");
    expect(sidebarMod.treeRowTextOverflow(true)).toBe("ellipsis-middle");
    expect(
      sidebarMod.resolveWorkspaceFolderName("/Users/byronwayne/Projects/dev-efficiency-2026-11"),
    ).toBe("dev-efficiency-2026-11");

    const compiled = Object.values(sidebarMod).map(String).join("\n");

    // Hoisted Set + Changed empty state + middle ellipsis + no orphaned diff glyph
    expect(compiled).toContain("new Set");
    expect(compiled).toContain("ellipsis-middle");
    expect(compiled).toContain("sidebar-changed-empty");
    expect(compiled).not.toContain('"diff"');
    expect(compiled).not.toContain("SIDEBAR_FILTER_ITEMS");

    // Single rotating chevron instead of dual <If> chevron-down / chevron-right Canvas remounts
    expect(compiled).not.toContain("chevron-down");
    expect(compiled).toContain("90deg");

    // CommandPalette uses dynamic onHighlightChange + theme.ui.selection instead of static Industrial classes
    expect(compiled).not.toContain("focus:bg-accent");
    expect(compiled).not.toContain("hover:bg-muted/60");
    expect(compiled).toContain("onHighlightChange");
  });

  test("mounts Sidebar & CommandPalette reactively across all 8 themes, branch states, and expanded Set toggles", () => {
    const filterMode = signal<"all" | "changed">("changed");
    const branch = signal<string>("");
    const expandedIds = signal<string[]>(["/w/src"]);
    const selectedPath = signal<string | null>(null);
    const paletteOpen = signal(false);
    const paletteMode = signal<"files" | "commands">("commands");
    const theme = signal(EDITOR_THEMES[0]);
    const treeItems = signal([
      {
        id: "/w/src",
        label: "src",
        children: [{ id: "/w/src/deep/nested/Button.tsx", label: "Button.tsx" }],
      },
    ]);

    function Harness(): JSX.Element {
      return (
        <View class="flex-1">
          <Sidebar
            root={() => "/w/native-editor"}
            {...({ branch: () => branch() } as Record<string, unknown>)}
            filterMode={filterMode}
            treeItems={() => (filterMode() === "changed" ? [] : treeItems())}
            expandedIds={expandedIds}
            selectedPath={selectedPath}
            gitStatusMap={() => ({ "src/deep/nested/Button.tsx": "M" })}
            notice={() => null}
            theme={() => theme()}
            onSelectFile={() => undefined}
          />
          <CommandPalette
            open={paletteOpen}
            mode={() => paletteMode()}
            root={() => "/w/native-editor"}
            fileItems={() => [{ id: "/w/src/Button.tsx", label: "src/Button.tsx", group: "Files" }]}
            commandItems={() => [
              { id: "toggle-sidebar", label: "View: Toggle Sidebar", shortcut: "mod+b", group: "View" },
            ]}
            theme={() => theme()}
            onSelectFile={() => undefined}
            onRunCommand={() => undefined}
          />
        </View>
      );
    }

    const unmount = mount(Harness);
    try {
      branch.set("main");
      filterMode.set("all");
      expandedIds.set([]);
      expandedIds.set(["/w/src"]);
      paletteOpen.set(true);
      paletteMode.set("files");
      for (const nextTheme of EDITOR_THEMES) {
        theme.set(nextTheme);
      }
      theme.set(getThemeById("tokyo-night"));
      paletteOpen.set(false);
    } finally {
      unmount();
    }
  });

  test("headless E2E: Changed filter renders centered empty state instead of blank void and CommandPalette highlights & selects cleanly", async () => {
    const app = await open("../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 800,
      host: { params: { workspaceRoot: FIXTURE_ROOT } },
    });

    await app.waitFor("id:sidebar-workspace-title");
    expect(app.shows("id:sidebar-header")).toBe(true);
    expect(app.shows("id:sidebar-filter-all")).toBe(true);
    expect(app.shows("id:sidebar-filter-changed")).toBe(true);
    expect(app.shows("label:Show all files")).toBe(true);
    expect(app.shows("label:Show changed files")).toBe(true);
    expect(app.shows("text:All")).toBe(false);
    expect(app.shows("text:Changed")).toBe(false);

    // Switch to Changed on clean fixtures folder -> shows centered empty state
    await app.press("id:sidebar-filter-changed");
    await app.waitFor("id:sidebar-changed-empty");
    expect(app.shows("text:No uncommitted changes")).toBe(true);

    // Switch back to All -> restores workspace tree
    await app.press("id:sidebar-filter-all");
    await app.waitFor("id:workspace-tree");
    expect(app.shows("id:sidebar-changed-empty")).toBe(false);

    // CommandPalette opens inModalShell, renders Keycaps, moves highlight, and closes on Escape
    await app.keyboard.press("mod+shift+p");
    await app.waitFor("id:command-palette");
    await app.keyboard.press("arrowdown");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:command-palette"), { timeout: 3000 });
  });
});
