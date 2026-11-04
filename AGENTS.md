# AGENTS.md

Lightweight native editor and multi-format file previewer built on Native Shell (`nsh 0.3.0`, pure TSX `--template ts`). No plugin system. Ships a dockable workspace (`DockArea`), file tree with Git status (`Tree`), quick open / command palette (`Command`), multi-format file preview (`Editor`, `TextView`, `DataTable`, `DiffView`, `Image`, `Video`, `WebView`, Quick Look, Hex), and a built-in interactive PTY terminal (`process.spawn` + Python `pty`).

## Layout

```text
nsh.json              App manifest and capability grants (fs, process, webview, clipboard, openUrl)
tsconfig.json         TypeScript config (.nsh/types)
App.tsx               Window chrome, menu bar, DockArea layout, keybindings, state wiring
src/
  workspace.ts        Directory listing, git status (-z), folder picker (osascript), file read/write
  classify.ts         File kind detection, CSV/TSV/JSONL parser, hex dump formatter, Quick Look helper
  Sidebar.tsx         Explorer tree (All / Changed filter) and Cmd+P / Cmd+Shift+P Command palette
  PreviewPane.tsx     Preview / Source switch and renderers per file kind
  TerminalPane.tsx    Bottom dock multi-tab PTY terminal (python3 pty bridge, ANSI SGR, input/history)
App.test.tsx          End-to-end headless & interactive verification (nsh/test)
```

## NSH Constraints (Verified in 0.3.0)

- **Tags and imports**: Every JSX tag is PascalCase (`<View>`, `<Text>`, `<If>`, `<Each>`). Lowercase HTML tags fail to compile. `<If when={...}>` and `<Each of={...}>{(item, index) => ...}</Each>` are globals (do **not** import `If` or `Each`). Import primitives (`View`, `Text`, `Scroll`, `Image`, `Video`, `WebView`, `Overlay`, `signal`, `computed`, `effect`, `cleanup`, `keymap`, `mount`, `colorScheme`, `setColorScheme`) from `"nsh"`, base components (`DockArea`, `Editor`, `TextView`, `DataTable`, `DiffView`, `Tree`, `Command`, `Dialog`, `Button`, `Input`, `Menu`) from `"nsh/base"`, desktop window/menu APIs (`Window`, `Menu`, `titleBar`) from `"nsh/desktop"`, and standard modules (`"fs/promises"`, `"process"`, `"path"`, `"os"`, `"url"`, `"buffer"`) as bare specifiers without `node:`.
- **Event payloads**: Every NSH event passes a single object (`onChange={({ value }) => …}`, `onLayoutChange={({ layout }) => …}`, `onSelectedChange={({ selected }) => …}`, `renderPanel={({ id }) => …}`).
- **Subprocesses and filesystem**: `process.run` and `process.spawn` require an explicit `{ cwd }` within a granted `capabilities.fs.write` root (`${homeDir}` or `/tmp`); omitting `cwd` throws when no host data directory is set. Never use `~` or `$HOME` in `nsh.json`—use `${homeDir}`.
- **Local images**: Read bytes with `fs.readFile(path)` and pass `URL.createObjectURL(new Blob([bytes], { type }))` to `<Image src={blobUrl} />`. `nsh-js` resolves `blob:` URLs directly from the `Blob`'s `Arc<[u8]>` in Rust without copying or base64 encoding.

## Commands & Verification

```sh
nsh check                           # TypeScript 7 native typecheck (~0.2s)
nsh test --trace                    # Headless end-to-end test + commit/frame metrics (~1.0s)
nsh test App.tsx --target macos     # Real AppKit window test driven via stdin steps
nsh run --target macos              # Development host with hot reload
nsh package --target macos          # Standalone macOS .app bundle (~64ms warm, ~37 MB)
```

- **Desktop headless test options**: In `App.test.tsx`, always call `open("./App.tsx", { platform: "macos", width: 1280, height: 800 })`. Without `platform: "macos"`, `nsh/test` defaults to `"ios"` (390×844), which disables `fs/promises` and `process` and collapses `DockArea` into mobile drawer mode (< 600pt).
- **Single-runner rule**: Only the lead coordinator runs `nsh check`, `nsh test`, `nsh package`, or `ub-mode`. Worker agents edit their assigned files and report back.

## Herdr-Native Development Workflow (All Operations in Herdr)

**All operations—coding (`epi`), code review (`ub-mode`), testing (`nsh check`, `nsh test`), and packaging (`nsh package`)—must execute visibly inside Herdr tabs/terminals in the current Herdr space** (`native-editor`, space ID from `herdr-app ls`, lead terminal `$HC_TERMINAL_ID`). Never run build/review/package stages hidden in background tool subshells when the user is observing the space.

1. **Coding (`epi` Multi-Model Workers)**:
   - `antigravity/gemini-3.8-flash`: UI shell, `DockArea` integration, `Sidebar.tsx`, `PreviewPane.tsx`, `App.tsx`.
   - `factory/deepseek-v4.1-flash`: Data layer, file classification/parsers, `workspace.ts`, `classify.ts`, `TerminalPane.tsx`, `App.test.tsx`.
   ```sh
   hc run --bg --name epi-gemini --cwd /Users/byronwayne/Projects/sides/native-editor \
     --label herdr.space=<current-space-id> \
     epi --model antigravity/gemini-3.8-flash

   hc run --bg --name epi-deepseek --cwd /Users/byronwayne/Projects/sides/native-editor \
     --label herdr.space=<current-space-id> \
     epi --model factory/deepseek-v4.1-flash
   ```
   - Wait for readiness with `hc wait <name>`, then assign file-scoped tasks with `hc send <name> "<task>. Report with hc send $HC_TERMINAL_ID when done or stuck."`
   - Workers must not spawn subagents or touch files outside their scope.

2. **Review, Testing & Packaging in Dedicated Herdr Tabs**:
   - Open or reuse a visible tab in the current Herdr space (`herdr-app do tab.new --space <current-space-id> --name <tab-name> --folder /Users/byronwayne/Projects/sides/native-editor`) and run commands via `hc send <terminal-id> '<cmd>'`:
     - **Review & Quality Gate (`review` / `package` tab)**:
       ```sh
       hc send <term> 'nsh check && sh ~/.gemini/config/skills/ub-mode/scripts/ub crapper --no-coverage App.tsx src/ && sh ~/.gemini/config/skills/ub-mode/scripts/ub dryer App.tsx src/'
       ```
     - **Testing (`test` / `package` tab)**:
       ```sh
       hc send <term> 'nsh test --trace && nsh test App.tsx --target macos'
       ```
     - **Packaging (`package` tab)**:
       ```sh
       hc send <term> 'rm -rf .nsh/out && nsh check && nsh test && nsh package --target macos && ls -lh ".nsh/out/Native Editor.app/Contents/MacOS"'
       ```
   - Keep the `package` / verification tab open for the user to inspect logs, and clean up temporary `epi` worker terminals (`hc kill <name>; hc rm <name>`) only after completion. Never close or modify pre-existing user spaces, tabs, or panes.
