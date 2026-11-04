# Native Editor 调研与架构设计草案

目标：用 NSH（`nsh 0.3.0`）做一个轻量级、类似 VS Code 的桌面编辑器。核心诉求是**不同类型文件的预览**与**内置终端等常用工作区功能**，不做插件系统。

---

## 1. 调研与实测结论

我们在本机 `nsh 0.3.0 (df6aa34)` 上对 `~/.nsh/source` 源码和两种项目模板（`--template ts` 与 `--template mixed`）做了实操验证：

### 1.1 NSH 已内置的原生能力（Rust 层直接提供，无需手写底层）
`nsh-base` 和 `nsh-core` 已经在 Rust 侧实现了编辑器所需的重组件，TSX 只负责声明布局和状态绑定：
- **`DockArea`（可停靠工作区）**：支持 `left`（文件树）、`center`（多 Tab 组、水平/垂直分屏、拖拽 Tab 到边缘自动分屏、`toggleZoom` 组最大化）、`bottom`（终端面板）。内容按 `PanelId` 保持在原生层，跨分屏拖拽 Tab 不会丢失编辑器光标、滚动位置或终端会话。
- **`Editor`（代码编辑器）**：底层是 Rust `ropey::Rope` + `two_face`（`bat` 的扩展 `syntect` 语法库，覆盖 200+ 语言），支持行号、代码折叠、多光标、括号匹配、正则查找替换、诊断标记。20 万行文本布局约 30ms。
- **`TextView`（文档渲染）**：原生解析并渲染 CommonMark + GFM（表格、任务列表、脚注、GitHub Alerts、LaTeX 公式、语法高亮代码块）和 HTML。
- **`DiffView`（对比视图）**：支持 `oldValue` / `newValue` 或直接传入 `git diff` patch，支持 Split / Unified 切换和按 hunk 跳转。
- **`DataTable`（双向虚拟滚动表格）**：按视口行范围（`onVisibleRowsChange`）喂数据，百万行级 CSV / TSV / JSONL 表格滚动只消耗屏幕可见行的开销，支持列宽拖拽、固定列、排序。
- **`Tree` 与 `Command`**：虚拟化文件树（单 Tab 焦点，方向键展开/收起）和虚拟化命令面板（`Cmd+P` 文件快搜、`Cmd+Shift+P` 命令面板，5000+ 文件按键级原生过滤）。
- **`Image` / `Video` / `WebView`**：本地文件通过 `fs.readFile(path)` 拿到 `Uint8Array`，构造 `URL.createObjectURL(new Blob([bytes], { type }))` 传给 `<Image src={blobUrl} />`。`nsh-js` 直接在 Rust 侧共享 `Blob` 的 `Arc<[u8]>`，零拷贝、不转 base64。

### 1.2 为什么选纯 TSX（`--template ts`）而不是混合 Rust（`--template mixed`）
我们在 `scratch/` 下分别初始化并实测了两个原型：

| 维度 | 纯 TSX (`--template ts`) | 混合模板 (`--template mixed`) |
|---|---|---|
| `nsh check` 耗时 | **~0.2s**（直接跑内置原生 `tsc`） | 首次 **40.2s**，增量检查需走 Cargo |
| `nsh test` 耗时 | **0.75s – 1.0s**（含 `DockArea` + `Editor` + `fs` + `pty`） | 首次编译 192 MB 测试二进制耗时 **1m 10s** |
| `nsh package --target macos` | 复用预编译 runner，打包仅 **64ms**（`.app` 大小 **37 MB**） | 每次改 Rust 需重链 release runner |
| 多 Agent 并行开发 | 零 Cargo 锁冲突，极适合 `epi` 多模型并行改 TSX | 并发触发 `cargo` 会锁死 `.nsh/rust` |
| 本地文件与终端能力 | `nsh.json` 声明 `capabilities.fs` (`${homeDir}`, `/tmp`) 与 `capabilities.process` 即可直接调用 | 需手写 `#[module]` / `#[class]` 胶水代码 |

**实测踩坑与关键发现（已写入 `AGENTS.md`）**：
1. `nsh test` 默认把 headless 视口设为 `{ platform: "ios", width: 390, height: 844 }`，此时 `fs/promises` 和 `process` 会报错 `native filesystem unavailable on this platform`，且 `DockArea` 因宽度 `< 600pt` 会折叠成移动端抽屉。测试桌面应用时必须传 `open("./App.tsx", { platform: "macos", width: 1280, height: 800 })`。
2. `process.run` 和 `process.spawn` 在未配置宿主 `dataDir` 时必须显式传入 `{ cwd }`（且 `cwd` 在 `capabilities.fs.write` 授权目录内，如 `os.homedir()` 或当前工作区路径）。
3. **内置真 PTY 终端无需写 Rust 扩展**：通过 `process.spawn("python3", ["-u", "-c", PY_PTY_SCRIPT], { cwd, stdin: "pipe" })` 调用标准库 `pty.fork()` 启动 `$SHELL`，我们在 `nsh test` 中实测验证了子进程内 `sys.stdin.isatty() === True`。

---

## 2. 架构设计

### 2.1 整体界面布局（单窗口极简 IDE）

```text
+-----------------------------------------------------------------------------------+
| ● ● ●  [Native Editor]   📁 ~/Projects/...   [🔍 Quick Open (⌘P)]    [☀️/🌙] [⌘J] |  <- 自定义 TitleBar (38pt, windowDrag)
+--------------------+--------------------------------------------------------------+
| EXPLORER           | [📄 README.md ×] [🦀 main.rs • ×] [📊 data.csv ×]  [Preview|Source] |
| [All] [Changed 3]  +--------------------------------------------------------------+
|                    |                                                              |
| ▾ src/             |                                                              |
|     App.tsx      M |                 多格式文件预览 / 编辑器主区域                   |
|     workspace.ts   |       (Editor / TextView / DataTable / DiffView /            |
| ▸ assets/          |        Image / Video / WebView / Quick Look / Hex)           |
|   README.md        |                                                              |
|   data.csv         |                                                              |
|                    +--------------------------------------------------------------+
|                    | TERMINAL  [zsh 1 ×] [zsh 2 ×] [+]               [Clear] [×]  |
|                    | $ git status                                                 |
|                    | On branch main ...                                           |
|                    | > ________________________________________________ [Send ⏎]  |
+--------------------+--------------------------------------------------------------+
| ⎇ main  •  2 changed  |  UTF-8  |  Markdown (Preview)  |  Ln 12, Col 4            |  <- StatusBar (24pt)
+-----------------------------------------------------------------------------------+
```

### 2.2 文件预览路由（`src/classify.ts` + `src/PreviewPane.tsx`）

所有文件打开后先根据扩展名与前 4 KB 字节（是否含 `\0`）判定类型。支持预览的格式在面板右上角提供 **`Preview` / `Source`（或 `Diff`）** 一键切换，以及 **在系统默认应用中打开** 按钮：

1. **代码与配置文件**（`.rs`, `.ts`, `.tsx`, `.js`, `.py`, `.go`, `.json`, `.toml`, `.yaml`, `.sh`, `.css`, `.sql`, `Dockerfile`, `Makefile` 等 200+ 种）：
   - 渲染组件：`<Editor value={...} language={ext} />`。
   - 功能：语法高亮、行号、代码折叠、`Cmd+F` 页内搜索替换、`Cmd+S` 保存修改（未保存时 Tab 显示圆点 `•`）。
2. **Markdown 文档**（`.md`, `.markdown`, `.mdx`）：
   - 默认 `Preview`：`<TextView markdown={text} selectable />`（若装有 `mmd2txt` 则自动预处理 ` ```mermaid ` 块；点击文档内相对路径链接直接在编辑器新 Tab 打开对应文件）。
   - 切 `Source`：`<Editor value={text} language="markdown" />`。
3. **表格数据**（`.csv`, `.tsv`, `.jsonl`）：
   - 默认 `Preview`：解析表头与行数据，通过 `<DataTable columns={...} data={slice} dataStart={...} rowCount={total} />` 渲染，支持点击列头升/降序排序。
   - 切 `Source`：`<Editor value={text} />`。
4. **Diff / Git 变更预览**（`.diff`, `.patch` 文件，或在左侧 `Changed` 列表点击带 `M`/`A`/`D` 标记的文件）：
   - 渲染组件：`<DiffView patch={gitDiffOutput} layout="split" | "unified" />`，带 `Prev / Next Hunk` 导航和 `+a -d` 统计。
5. **图片与矢量图**（`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`）：
   - 默认 `Preview`：`fs.readFile` -> `Blob` -> `URL.createObjectURL` -> `<Image src={blobUrl} style={{ objectFit: "contain" }} />`，底部显示分辨率与文件大小（`.svg` 额外支持切换 `Source` 编辑 XML）。
6. **HTML 网页**（`.html`, `.htm`）：
   - 默认 `Preview`：`<WebView html={text} />`（支持切换 `Source` 查看 HTML 源码）。
7. **PDF / Office / iWork 等系统文档**（`.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.pages`, `.numbers`, `.key`, `.rtf`）：
   - 复用 `herdr-app` `my-files` 验证过的轻量方案：通过 `qlmanage -t -s 2000` 生成高清预览图缓存到 `/tmp/native-editor-ql/`，再用 `<Image />` 展示首页/帧预览，并提供一键调用系统 `open` 打开原文件。
8. **音视频媒体**（`.mp4`, `.mov`, `.webm`, `.mp3`, `.wav`, `.m4a`）：
   - 渲染组件：`<Video src={fileUrlOrBlob} controls />`。
9. **二进制文件兜底**（含 `\0` 的未知二进制文件）：
   - 读取前 4 KB 格式化为 `偏移量 | 16 进制字节 | ASCII 可打印字符` 的只读 `<Editor />` 视图，绝不卡死 UI。

### 2.3 内置终端（`src/TerminalPane.tsx`）
- 每个终端 Tab 对应一个 `PtySession` 实例：
  - 使用 `process.spawn("python3", ["-u", "-c", PY_PTY_BRIDGE], { cwd: workspaceRoot, stdin: "pipe" })` 启动真实伪终端（`pty.fork()` + `$SHELL -l`）。
  - 输出流处理：处理回车覆盖 `\r`、退格 `\b`、清屏 `\x1b[2J` / `\x1b[3J`，并将 ANSI SGR 颜色码解析为带颜色的文本行（保留最近 2000 行缓冲）。
  - 交互控制：支持多 Tab 新建（`+`）、关闭、切换；输入栏支持 `Enter` 执行、`↑`/`↓` 历史命令回溯、`Ctrl+C`（发送 `\x03` 中断前台命令）、`Clear` 清屏，以及快捷运行当前打开的脚本文件。

### 2.4 常用快捷键与工作区功能
- `Cmd+O`：通过 macOS 原生 `osascript -e 'POSIX path of (choose folder)'` 选择并切换工作区目录（同时支持拖拽文件夹/文件到窗口 `onFileDrop`）。
- `Cmd+P` / `Cmd+K`：打开 `Command` 面板快速模糊搜索并打开工作区内的文件。
- `Cmd+Shift+P`：打开命令面板（切换侧边栏、切换终端、分屏预览、切换亮暗主题、保存文件、刷新文件树）。
- `Cmd+B`：展开/收起左侧文件树 Dock。
- `` Ctrl+` `` / `Cmd+J`：展开/收起底部内置终端 Dock。
- `Cmd+S`：保存当前激活的编辑器文件并刷新 Git 状态。
- `Cmd+W`：关闭当前激活的 Tab。

---

## 3. 基于 `epi` + Herdr 当前 Space 的全流程开发规范（All-in-Herdr）

当前会话运行在 Herdr 的 `native-editor` space（`spbfa2a29fdfc6274e8990c72f4e0ff3e1`，主终端 `t1k`）。**所有开发动作（Code、Review、Test、Package）必须在当前 Herdr Space 的可见终端/标签页内执行**，不把构建、审查或打包藏在不可见的后台子进程里：

1. **脚手架初始化**：
   - 初始化 `nsh.json`、`tsconfig.json` 与基础目录结构，生成 `.nsh/types` 类型声明，定义好 `src/` 各模块的 TypeScript 接口签名。
2. **Code：在当前 Herdr Space 启动双模型 `epi` Workers**：
   - **Worker 1 (`epi-deepseek`, `factory/deepseek-v4.1-flash`)**：
     - 负责 `src/workspace.ts`、`src/classify.ts` 以及 `src/TerminalPane.tsx`。
   - **Worker 2 (`epi-gemini`, `antigravity/gemini-3.8-flash`)**：
     - 负责 `src/Sidebar.tsx`、`src/PreviewPane.tsx` 以及 `App.tsx`。
3. **Review / Test / Package：在当前 Herdr Space 打开可见终端标签页执行**：
   - 通过 `herdr-app do tab.new --space <space-id> --name <tab> --folder /Users/byronwayne/Projects/sides/native-editor` 创建或复用可见终端（如 `t2b`），用 `hc send <term> '<cmd>'` 驱动全流程，方便实时观察输出：
     - **Review（类型与代码质量审查）**：在 Herdr 终端内运行 `nsh check` 与 `ub-mode`（`crapper` 复杂度 < 10、`dryer` 重复率检查、`mutator` 变异测试）。
     - **Test（无头与真机窗口实操测试）**：在 Herdr 终端内运行 `nsh test --trace` 与 `nsh test App.tsx --target macos`。
     - **Package（发布打包）**：在 Herdr 终端内运行 `nsh package --target macos` 并保留标签页供随时查看日志或直接启动 `.nsh/out/Native Editor.app`。

---

## 4. 模块接口契约（TypeScript 精确签名）

为确保 `epi-deepseek` 与 `epi-gemini` 并行开发零冲突，各模块导出签名固定如下：

### 4.1 `src/classify.ts`（由 `epi-deepseek` 实现）

```ts
import type { DataTableColumn } from "nsh/base";

export type FileKind =
  | "code"
  | "markdown"
  | "html"
  | "table"
  | "diff"
  | "image"
  | "video"
  | "quicklook"
  | "binary";

export type PreviewMode = "preview" | "source" | "diff";

export interface TableData {
  columns: DataTableColumn[];
  rows: (string | number)[][];
}

export interface FileClassification {
  kind: FileKind;
  language: string;
  defaultMode: PreviewMode;
  supportsPreview: boolean;
  mimeType: string;
}

/** Classify a file by its path and optional leading bytes (up to 4 KB). */
export function classifyFile(filePath: string, sampleBytes?: Uint8Array): FileClassification;

/** Parse CSV, TSV, or JSONL text into DataTable columns and rows. */
export function parseTableData(text: string, filePath: string): TableData;

/** Format leading bytes (up to 4 KB) as a classic hex + ASCII dump. */
export function formatHexDump(bytes: Uint8Array, maxBytes?: number): string;

/** Generate a macOS Quick Look thumbnail PNG for PDF/Office/iWork files and return a blob: URL (or null on failure). */
export async function generateQuickLookUrl(filePath: string, cwd: string): Promise<string | null>;

/** Create a zero-copy blob: URL from raw file bytes and MIME type. */
export function createBlobUrl(bytes: Uint8Array, mimeType: string): string;
```

### 4.2 `src/workspace.ts`（由 `epi-deepseek` 实现）

```ts
import type { CommandItem, TreeItem } from "nsh/base";
import type { FileClassification, PreviewMode, TableData } from "./classify";

export type GitStatusCode = "M" | "A" | "D" | "U" | "R";

export interface WorkspaceEntry {
  path: string;       // absolute path
  relPath: string;    // relative to workspace root
  name: string;
  isDirectory: boolean;
  gitStatus?: GitStatusCode;
  children?: WorkspaceEntry[];
}

export interface WorkspaceSnapshot {
  root: string;
  branch: string;
  entries: WorkspaceEntry[];
  flatFiles: WorkspaceEntry[];
  gitStatusMap: Record<string, GitStatusCode>;
  treeItemsAll: TreeItem[];
  treeItemsChanged: TreeItem[];
  commandItems: CommandItem[];
}

export interface LoadedFile {
  path: string;
  relPath: string;
  name: string;
  size: number;
  classification: FileClassification;
  mode: PreviewMode;
  text: string;
  savedText: string;
  dirty: boolean;
  blobUrl: string | null;
  quickLookUrl: string | null;
  tableData: TableData | null;
  hexDump: string;
  diffPatch: string;
}

/** Resolve initial workspace root from process.env.NATIVE_EDITOR_ROOT or process.cwd() or os.homedir(). */
export function getInitialWorkspaceRoot(): string;

/** Scan workspace directory, git branch, and git status (-z). */
export async function scanWorkspace(root: string): Promise<WorkspaceSnapshot>;

/** Load a file for preview/editing (reads bytes, classifies, parses table/hex/diff/blob as needed). */
export async function loadFile(filePath: string, root: string, preferredMode?: PreviewMode): Promise<LoadedFile>;

/** Save text content to disk and return updated LoadedFile state. */
export async function saveFileText(file: LoadedFile, newText: string, root: string): Promise<LoadedFile>;

/** Fetch git diff patch for a specific file (staged + unstaged vs HEAD). */
export async function getFileDiffPatch(filePath: string, root: string): Promise<string>;

/** Open macOS folder picker dialog via osascript and return selected folder path or null. */
export async function pickWorkspaceFolder(cwd: string): Promise<string | null>;

/** Open file in macOS default application (`open <path>`). */
export async function openInDefaultApp(filePath: string, cwd: string): Promise<void>;

/** Reveal file in macOS Finder (`open -R <path>`). */
export async function revealInFinder(filePath: string, cwd: string): Promise<void>;
```

### 4.3 `src/TerminalPane.tsx`（由 `epi-deepseek` 实现）

```tsx
import type { Accessor } from "nsh";

export interface TerminalPaneProps {
  cwd: Accessor<string>;
  onFileOpen?: (filePath: string) => void;
}

export function TerminalPane(props: TerminalPaneProps): JSX.Element;
```

### 4.4 `src/Sidebar.tsx`（由 `epi-gemini` 实现）

```tsx
import type { Accessor, Signal } from "nsh";
import type { CommandItem, TreeItem } from "nsh/base";
import type { GitStatusCode } from "./workspace";

export interface SidebarProps {
  root: Accessor<string>;
  branch: Accessor<string>;
  filterMode: Signal<"all" | "changed">;
  treeItems: Accessor<TreeItem[]>;
  expandedIds: Signal<string[]>;
  selectedPath: Signal<string | null>;
  gitStatusMap: Accessor<Record<string, GitStatusCode>>;
  changedCount: Accessor<number>;
  onSelectFile: (filePath: string, openInDiff?: boolean) => void;
  onRefresh: () => void;
  onOpenFolder: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element;

export interface CommandPaletteProps {
  open: Signal<boolean>;
  mode: Accessor<"files" | "commands">;
  fileItems: Accessor<CommandItem[]>;
  commandItems: Accessor<CommandItem[]>;
  onSelectFile: (filePath: string) => void;
  onRunCommand: (commandId: string) => void;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element;
```

### 4.5 `src/PreviewPane.tsx`（由 `epi-gemini` 实现）

```tsx
import type { Accessor } from "nsh";
import type { LoadedFile } from "./workspace";
import type { PreviewMode } from "./classify";

export interface PreviewPaneProps {
  file: Accessor<LoadedFile | undefined>;
  workspaceRoot: Accessor<string>;
  onTextChange: (filePath: string, newText: string) => void;
  onSave: (filePath: string) => void;
  onModeChange: (filePath: string, mode: PreviewMode) => void;
  onOpenRelativeLink: (relUrl: string, baseFilePath: string) => void;
  onCursorChange?: (line: number, column: number) => void;
}

export function PreviewPane(props: PreviewPaneProps): JSX.Element;
```

