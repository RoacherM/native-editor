import { cleanup, computed, mount, Text, View, windowSize, type Accessor, type JSX } from "nsh";
import { ResizablePanel, ResizablePanelGroup, type ResizeHandleContext } from "nsh/base";
import { isAvailable as desktopAvailable, titleBar } from "nsh/desktop";
import {
  bindAppShortcuts, BUILT_IN_COMMANDS, enforceMinWindowSize,
  MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, runBuiltInCommand, setupDesktopChrome,
} from "./src/commands";
import { FileBadge, Icon } from "./src/icons";
import { PreferencesModal, UnsavedChangesDialog } from "./src/PreferencesModal";
import { PreviewPane } from "./src/PreviewPane";
import { CommandPalette, Sidebar } from "./src/Sidebar";
import { TerminalPane } from "./src/TerminalPane";
import type { EditorTheme } from "./src/themes";
import { IconButton, NoticeBanner, SegmentedControl, SurfaceButton, TabStrip } from "./src/ui";
import { EmptyEditorPanel, WelcomePanel } from "./src/WelcomePanel";
import { createWorkspaceSession, type WorkspaceSession } from "./src/workspaceSession";

function splitHandleColor(ui: EditorTheme["ui"], state: ResizeHandleContext["state"]): string {
  if (state === "dragging" || state === "pressed") return ui.accent;
  return state === "hovered" ? `${ui.accent}b3` : ui.border;
}

function renderSplitHandle(theme: Accessor<EditorTheme>, ctx: ResizeHandleContext): JSX.Element {
  const cls = ctx.axis === "horizontal" ? "w-px h-full" : "h-px w-full";
  return <View class={cls} style={{ backgroundColor: splitHandleColor(theme().ui, ctx.state) }} />;
}

function clampPanelMax(dim: number, fallback: number, min: number, max: number, reserve: number): number {
  return Math.min(max, Math.max(min, (dim || fallback) - reserve));
}

function WindowTitleBar(props: { session: WorkspaceSession }): JSX.Element {
  const s = props.session;
  const barHeight = computed(() => Math.max(32, desktopAvailable ? titleBar().height : 32));
  const leftPad = computed(() => Math.max(12, desktopAvailable ? titleBar().left : 12));

  return (
    <View
      desktop={{ windowDrag: true }}
      class="flex-row items-center justify-between pr-3 shrink-0 select-none bg-sidebar"
      style={{ height: barHeight(), paddingLeft: leftPad() }}
    >
      <View class="flex-1 flex-row items-center justify-center min-w-0 px-3">
        <SurfaceButton
          size="sm" testID="titlebar-quick-open" onPress={s.actions.openQuickOpen}
          class="flex-1 max-w-[320px] min-w-0 bg-background overflow-hidden"
        >
          <Icon name="search" size={12} tint={() => s.activeTheme().ui.mutedForeground} />
          <Text class="text-xs text-muted-foreground truncate">{s.folderLabel()}</Text>
        </SurfaceButton>
      </View>
      <View class="flex-row items-center gap-1 shrink-0">
        <IconButton
          icon="sidebar" iconSize={14} testID="titlebar-toggle-sidebar" accessibilityLabel="Toggle sidebar"
          disabled={!s.workspaceRoot()} selected={s.sidebarOpen() && Boolean(s.workspaceRoot())}
          onPress={s.actions.toggleSidebar}
        />
        <IconButton
          icon="panel-bottom" iconSize={14} testID="titlebar-toggle-terminal" accessibilityLabel="Toggle terminal"
          selected={s.terminalOpen()} onPress={s.actions.toggleTerminal}
        />
      </View>
    </View>
  );
}

function EditorTabBar(props: { session: WorkspaceSession }): JSX.Element {
  const s = props.session;
  return (
    <If when={s.tabs.tabs().length > 0}>
      <TabStrip
        items={s.tabs.tabs()} activeId={s.tabs.activePath()}
        getId={(t) => t.path()} getPath={(t) => t.path()}
        getLabel={(t) => t.doc.file().name} getTestKey={(t) => t.doc.file().name}
        isDirty={(t) => t.doc.dirty()} leading={(t) => <FileBadge name={() => t.doc.file().name} />}
        trailing={
          <If when={s.activeModeItems().length > 0}>
            <View class="px-2 shrink-0">
              <SegmentedControl
                items={s.activeModeItems()} value={s.activeTab()?.doc.mode() ?? "preview"}
                onChange={(m) => s.actions.setMode(m)}
              />
            </View>
          </If>
        }
        onSelect={(id) => s.selectTab(String(id))} onClose={(id) => s.closeTab(String(id))}
      />
    </If>
  );
}

function StatusBar(props: { session: WorkspaceSession }): JSX.Element {
  const s = props.session;
  const ink = computed(() => s.activeTheme().ui.statusBarForeground ?? s.activeTheme().ui.mutedForeground);

  return (
    <View
      testID="status-bar" class="h-6 px-3 select-none flex-row items-center justify-between shrink-0"
      style={{ backgroundColor: s.activeTheme().ui.statusBar ?? s.activeTheme().ui.sidebar }}
    >
      <View class="flex-row items-center gap-2">
        <If when={Boolean(s.workspaceRoot() && s.snapshot().branch)}>
          <View class="flex-row items-center gap-1">
            <Icon name="branch" size={12} tint={ink} />
            <Text class="text-[11px] font-mono" style={{ color: ink() }}>
              {`${s.snapshot().branch}${s.changedCount() > 0 ? "*" : ""}`}
            </Text>
          </View>
        </If>
      </View>
      <View class="flex-row items-center gap-1.5 min-w-0">
        <Each of={s.statusSegments()} key={(seg, idx) => `${idx}-${seg}`}>
          {(seg, idx) => (
            <View class="flex-row items-center gap-1.5 shrink-0">
              <If when={idx() > 0}>
                <Text class="text-[11px] font-mono opacity-60" style={{ color: ink() }}>·</Text>
              </If>
              <Text class="text-[11px] font-mono tabular-nums" style={{ color: ink() }}>{seg()}</Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function EditorSurfaceArea(props: { session: WorkspaceSession }): JSX.Element {
  const s = props.session;
  const f = () => s.activeFile();
  return (
    <View class="flex-1 min-h-0 overflow-hidden bg-background">
      <NoticeBanner
        fileName={f()?.name} saveError={f()?.saveError} openError={s.openError()} readOnly={f()?.readOnly}
        diskConflict={Boolean(f()?.dirty && f()?.diskChanged)} diskMissing={Boolean(f()?.diskMissing)}
        onDismissSaveError={s.dismissSaveError} onResolveConflict={(choice) => void s.resolveConflict(choice)}
        onCloseMissing={s.actions.closeCurrent} onDismissOpenError={() => s.openError.set(null)}
        onSaveAsMissing={() => { const cur = s.tabs.activePath(); if (cur) void s.saveCopyAs(cur); }}
      />
      <If when={s.editorSurface() === "file"}>
        <PreviewPane
          file={s.activeFile} tab={s.activeTab} workspaceRoot={s.workspaceRoot}
          fontFamily={s.fontFamily} fontSize={s.fontSize} theme={s.activeTheme}
          onTextChange={s.handleTextChange} onSave={(p) => void s.saveFile(p)}
          onModeChange={(p, m) => void s.setFileMode(p, m)}
          onOpenRelativeLink={(p, loc) => void s.openFileInTab(p, { location: loc })}
          onCursorChange={s.handleCursorChange} reveal={s.activeReveal} onRevealed={s.clearActiveReveal}
        />
      </If>
      <If when={s.editorSurface() === "welcome"}>
        <WelcomePanel
          recentWorkspaces={s.recentWorkspaces} theme={s.activeTheme}
          onSelectRecentWorkspace={s.switchToWorkspace}
        />
      </If>
      <If when={s.editorSurface() === "workspace-empty"}>
        <EmptyEditorPanel
          theme={s.activeTheme} onQuickOpen={s.actions.openQuickOpen}
          onOpenFolder={s.actions.openFolder} onCloseFolder={s.closeWorkspace}
          onToggleTerminal={s.actions.toggleTerminal}
        />
      </If>
    </View>
  );
}

function App(): JSX.Element {
  const s = createWorkspaceSession();
  setupDesktopChrome(s.actions, s.recentWorkspaces, s.switchToWorkspace, s.edited);
  cleanup(bindAppShortcuts(s.actions));

  const sidebarMax = computed(() => clampPanelMax(windowSize().width, 1280, 180, 420, 520));
  const terminalMax = computed(() => clampPanelMax(windowSize().height, 800, 120, 360, 316));
  const sidebarExtra: { branch?: Accessor<string> } = { branch: () => s.snapshot().branch };

  return (
    <View
      testID="app-root" class="flex-1 flex-col overflow-hidden bg-background"
      style={{ minWidth: MIN_WINDOW_WIDTH, minHeight: MIN_WINDOW_HEIGHT }}
      onLayout={({ bounds }) => enforceMinWindowSize(bounds.size.width, bounds.size.height)}
      onFileDrop={({ uris }) => void (async () => {
        for (const uri of uris) await s.openExternalFile(uri, "drop");
      })()}
    >
      <WindowTitleBar session={s} />
      <View testID="main-dock" class="flex-1 min-h-0 overflow-hidden bg-background">
        <ResizablePanelGroup
          axis="horizontal" class="flex-1 min-h-0 overflow-hidden bg-background"
          handleAccessibilityLabel="Resize sidebar"
          renderHandle={(ctx) => renderSplitHandle(s.activeTheme, ctx)}
        >
          <ResizablePanel
            visible={s.sidebarOpen() && s.workspaceRoot().length > 0} fixed
            size={Math.min(s.sidebarWidth(), sidebarMax())} minSize={180} maxSize={sidebarMax()}
            onResize={({ size }) => s.sidebarWidth.set(Math.round(size))}
            class="flex-col overflow-hidden bg-sidebar"
          >
            <Sidebar
              root={s.workspaceRoot} filterMode={s.filterMode} treeItems={s.treeItems}
              expandedIds={s.expandedIds} selectedPath={s.selectedPath}
              gitStatusMap={() => s.snapshot().gitStatusMap} notice={() => s.snapshot().rootNotice}
              theme={s.activeTheme}
              onSelectFile={(filePath, openInDiff) => void s.openFileInTab(filePath, { openInDiff })}
              {...sidebarExtra}
            />
          </ResizablePanel>
          <ResizablePanel minSize={520} class="flex-1 flex-col min-w-0 overflow-hidden bg-background">
            <ResizablePanelGroup
              axis="vertical" class="flex-1 min-h-0 overflow-hidden bg-background"
              handleAccessibilityLabel="Resize terminal"
              renderHandle={(ctx) => renderSplitHandle(s.activeTheme, ctx)}
            >
              <ResizablePanel minSize={260} class="flex-1 flex-col min-h-0 overflow-hidden bg-background">
                <EditorTabBar session={s} />
                <EditorSurfaceArea session={s} />
              </ResizablePanel>
              <ResizablePanel
                visible={s.terminalOpen()} fixed
                size={Math.min(s.terminalHeight(), terminalMax())} minSize={120} maxSize={terminalMax()}
                onResize={({ size }) => s.terminalHeight.set(Math.round(size))}
                class="flex-col overflow-hidden bg-sidebar"
              >
                <TerminalPane
                  cwd={s.workspaceRoot} visible={s.terminalOpen}
                  fontFamily={s.fontFamily} fontSize={s.fontSize} shellPath={s.defaultShell}
                  theme={s.activeTheme} onShellChange={s.setShellPath}
                  onFileOpen={(filePath: string, loc?: { line: number; column: number }) =>
                    void s.openFileInTab(filePath, { location: loc })
                  }
                  onEmpty={() => s.terminalOpen.set(false)}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </View>
      <StatusBar session={s} />
      <PreferencesModal
        open={s.fontDialogOpen} fontFamily={s.fontFamily} fontSize={s.fontSize} themeId={s.themeId}
        theme={s.activeTheme} defaultShell={s.defaultShell} shells={s.availableShells}
        onSetTheme={s.selectTheme} onSetFamily={s.setFontFamily} onAdjustSize={s.adjustFontSize}
        onSetShell={s.setShellPath} onReset={s.resetFont}
      />
      <UnsavedChangesDialog
        pending={s.pendingUnsaved}
        onSaveAndProceed={(g) => void s.handleSaveAndProceed(g)}
        onDiscardAndProceed={s.handleDiscardAndProceed}
      />
      <CommandPalette
        open={s.commandOpen} mode={s.commandMode} root={s.workspaceRoot}
        fileItems={s.paletteFileItems} commandItems={() => [...BUILT_IN_COMMANDS]} theme={s.activeTheme}
        onSelectFile={s.handlePaletteSelectFile} onRunCommand={(cmdId) => runBuiltInCommand(cmdId, s.actions)}
      />
    </View>
  );
}

mount(App);
export default App;
