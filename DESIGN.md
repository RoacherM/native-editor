---
title: Aed 架构与模块契约
description: 基于 Native Shell (nsh 0.3.0) 的 macOS 原生多格式预览器、代码编辑器与内置 PTY 终端（Aed — Another Editor）架构、持久化契约与实测踩坑记录。
---

# Aed 架构与模块契约

## 术语与边界

Aed（Another Editor）是基于 `nsh 0.3.0`（纯 TSX `--template ts`）构建的轻量级 macOS 原生文件预览器、编辑器与终端工作区。

- **拥有边界**：
  - 工作区目录扫描（深度 ≤ 4，单目录上限 200 项）、Git 变更状态解析（`git status --porcelain=v1 -z -uall`）与单文件 Diff 预览。
  - 10 类文件路由与渲染：`code`、`markdown`、`mermaid`、`html`、`table`（CSV/TSV/JSONL）、`diff`、`image`（PNG/JPG/GIF/WebP/AVIF/SVG）、`video`、`audio`、`quicklook`（PDF）、`binary`（4 KB Hex + ASCII）。
  - 内置多标签真 PTY 终端（`python3` `pty.fork()` 桥接）与本机 Ghostty 字体/主题/Shell 自动探测。
  - macOS Finder 双击/拖拽打开文件桥接（`libFinderBridge.dylib` + `launcher.c`）与 UTI 默认处理程序注册（`set_default_handlers.m`）。
- **不拥有边界**：不做插件市场/扩展宿主，不做 LSP 语言服务器客户端，不自带网络后端服务。

### 进程权限白名单（`nsh.json` `capabilities.process.execute`）

只放 app 自己 `process.run` / `process.spawn` 的 4 个二进制：`git`（状态与 diff）、`python3`（PTY 桥）、`sips`（PDF 预览图）、`osascript`（选目录）。终端里的 Shell 由 `python3` 的 `execvp` 拉起，不经过 nsh 的白名单，所以不需要列 `zsh` / `bash` / `sh`。新增一个 `process.run` 调用时，同时改这个列表和 `App.test.tsx` 里的最小权限断言。

### 持久化标识与 IPC 契约（不可随意改名）

| 类别 | 标识符 / 路径 | 用途与新旧兼容约定 |
|---|---|---|
| Bundle ID | `dev.byronwayne.aed` | `nsh.json` 与 `scripts/set_default_handlers.m` 共用；改名会导致 LaunchServices 默认打开关联失效 |
| `Storage` 键 | `aed.fontFamily` | 用户字体名；未设置时依次回退旧键 `native-editor.fontFamily`、Ghostty 配置或 `JetBrainsMono Nerd Font Mono` |
| `Storage` 键 | `aed.fontSize` | 字号（`9`–`28` 整数字符串）；未设置时回退旧键 `native-editor.fontSize`，非法值回退 Ghostty 字号或 `13` |
| `Storage` 键 | `aed.theme` | 主题 ID（8 套内置主题，默认 `industrial-paper`）；未设置时回退旧键 `native-editor.theme`，未知 ID 回退默认主题 |
| `Storage` 键 | `aed.shell` | 默认 Shell 绝对路径（如 `/bin/zsh`）；未设置时回退旧键 `native-editor.shell` |
| `Storage` 键 | `aed.recentWorkspaces` | JSON 字符串数组（最多保留最近 5 个显式打开的非 `/` 工作区目录，单独打开外部文件不写入）；未设置时回退旧键 `native-editor.recentWorkspaces`，解析失败回退 `[]` |
| 环境变量 / Host 参数 | `AED_ROOT` / `NATIVE_EDITOR_ROOT` / `host.params.workspaceRoot` | 启动时初始工作区目录；均未设置时返回 `""`（展示 Welcome 面板或恢复最近工作区，绝不自动扫 `$HOME`、`/` 或单文件父目录） |
| 环境变量 / Host 参数 | `AED_OPEN_FILE` / `NATIVE_EDITOR_OPEN_FILE` / `host.params.openFile` | 启动时直接以独立 Tab 打开的初始文件绝对路径（不覆盖当前工作区，不写入 `aed.recentWorkspaces`） |
| Finder 队列文件 | `/tmp/aed-open.queue` | `finder_bridge.m` 与 `launcher.c` 追加写入待打开文件路径（每行一个），`App.tsx` 每 450ms 通过 `consumeFinderOpenQueue()` 读取并清空 |
| 临时缓存目录 | `/tmp/aed-ql` | `generateQuickLookUrl()` 存放 `sips` 转换的 PDF 预览 PNG |
| 临时缓存目录 | `/tmp/aed-mermaid` | `src/mermaid.tsx` 缓存提取出的 `mermaid-docu-bundle.js` |

---

## 结构与数据流

```text
+-----------------------------------------------------------------------------------+
| ● ● ●                       [ 🔍 native-editor (⌘P) ]                  [◧] [◨]   | <- WindowTitleBar (32pt, windowDrag)
+--------------------+--------------------------------------------------------------+
| fixtures           | [📄 README.md ×] [📐 arch.mmd ×] [📊 metrics.csv ×]          | <- TabBar (36pt)
| [All] [Changed]    | src > components > 📄 README.md            [Preview] [Code]  | <- Breadcrumb & ModeBar (28pt)
| ▾ src/             +--------------------------------------------------------------+
|     App.tsx      M |                                                              |
|     classify.ts    |                 PreviewPane (按 FileKind 分发)               |
|     mermaid.tsx    |   Editor / TextView+Mermaid / DataTable / DiffView /         |
|     workspace.ts   |   Image (Zoom+Grid) / Video / Audio / QuickLook / Hex        |
|                    +--------------------------------------------------------------+
|                    | [1: zsh ×] [+]                                       [zsh ▾] | <- TerminalPane (ResizablePanel)
|                    | $ echo NSH_PTY_OK_2026                                       |
|                    | zsh $ _____________________________________________________  |
+--------------------+--------------------------------------------------------------+
| ⎇ master*          |                             README.md · 2.1 KB · Ln 1, Col 1 · markdown | <- StatusBar (24pt, read-only)
+--------------------+--------------------------------------------------------------+
```

### 模块职责表

| 文件 | 核心导出 | 职责边界 |
|---|---|---|
| `App.tsx` | `App` (mount root) | 顶层信号状态、可拖拽分栏（水平 `Sidebar` + 垂直 `PreviewPane`/`TerminalPane`）、快捷键、Finder 队列轮询、Preferences 弹窗 |
| `src/classify.ts` | `classifyFile`, `parseTableData`, `formatHexDump`, `probeImageDimensions`, `normalizeMachOBuildVersion`, `generateQuickLookUrl`, `createBlobUrl` | 纯文件类型判定（扩展名 + 前 4 KB `\0` 探测）、CSV/TSV/JSONL 解析、4 KB 十六进制格式化、PNG/GIF/SVG 尺寸探测、Mach-O `LC_BUILD_VERSION` 最低系统版本归一化、PDF `sips` 缩略图生成 |
| `src/workspace.ts` | `getInitialWorkspaceRoot`, `getInitialOpenFile`, `consumeFinderOpenQueue`, `scanWorkspace`, `loadFile`, `saveFileText`, `getFileDiffPatch`, `pickWorkspaceFolder`, `isDirectoryPath` | 工作区文件树与 Git 状态扫描、目录与普通文件区分、文件按需加载（音视频只 `stat` 不全量读入内存）、保存回写、`osascript` 选目录 |
| `src/PreviewPane.tsx` | `PreviewPane`, `formatMediaMeta` | 各 `FileKind` 的视图切换（`preview` / `source` / `diff`）、代码编辑器内联查找（`Cmd+F`）、表格排序、图片缩放（`25%`–`400%`）与棋盘格背景切换 |
| `src/mermaid.tsx` | `MermaidRendererHost`, `MermaidDiagramBlock`, `detectMermaidKind`, `preprocessMermaidCode`, `requestMermaidRender` | 隐藏离屏 `WebView`（1280×900）运行 Mermaid 布局、将 `<foreignObject>` 内联为原生 SVG `<text>` 并光栅化为 2x Retina PNG `blob:` URL |
| `src/Sidebar.tsx` | `Sidebar`, `CommandPalette` | 左侧 `All` / `Changed` 文件树、Git 状态徽章（`M`/`A`/`U`/`D`/`R`）、`Cmd+P` 文件快搜与 `Cmd+Shift+P` 命令面板 |
| `src/TerminalPane.tsx` | `TerminalPane`, `discoverTerminalEnvironment`, `parseGhosttyConfig` | 多标签 Python `pty.fork()` 终端会话、ANSI CSI/OSC 流式剥离与回车覆盖处理、本机 Shell 与 Ghostty 配置探测 |
| `src/themes.ts` | `EDITOR_THEMES`, `getThemeById`, `computeSyntaxDecorations`, `buildEditorThemeStyles` | 8 套配色主题（默认 Industrial Paper / Industrial Carbon，另有 Kanagawa Dragon、Tokyo Night、Catppuccin Mocha、One Dark、Rose Pine、GitHub Light）及多语言正则语法高亮装饰器 |
| `src/icons.tsx` | `Icon`, `FileBadge`, `AppLogo` | 内联矢量图标与按文件扩展名着色的类型徽章 |

---

## 文件预览与 Mermaid 渲染契约

1. **类型判定与大文件保护（`src/classify.ts` + `src/workspace.ts`）**：
   - `video`（`.mp4`, `.mov`, `.m4v`, `.webm`）与 `audio`（`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`）在 `loadFile()` 中只调用 `fs.stat()` 获取字节数并直接将文件路径传给 `<Video src={filePath} />`，绝不 `fs.readFile` 全量读入内存。
   - 图片（`.png`, `.jpg`, `.gif`, `.webp`, `.avif`, `.svg`）通过 `fs.readFile` 构造 `URL.createObjectURL(new Blob([bytes], { type }))`，由 `nsh-js` 在 Rust 侧零拷贝读取 `Blob` 的 `Arc<[u8]>`。
   - 未知扩展名文件读取前 4 KB，含 `\0` 字节则归类为 `binary`，展示只读 4 KB Hex + ASCII 视图。
2. **模式胶囊按钮显示规则（`App.tsx` `hasRichPreview`）**：
   - 仅对具备富预览能力的格式（`markdown`、`mermaid`、`table`、`html`、`image/svg+xml`）显示 `Preview` / `Code`（或 `Markdown`）切换按钮；当从左侧 `Changed` 列表以 `diff` 模式打开普通源码文件时，显示 `Diff` / `Code` 切换按钮；普通代码与二进制文件隐藏多余模式按钮。
3. **Mermaid 离屏光栅化流水线（`src/mermaid.tsx`）**：
   - Markdown 中的 ` ```mermaid ` 代码块（通过 `TextView` 的 `extensions` 拦截）与独立 `.mmd` / `.mermaid` 文件共用 `MermaidDiagramBlock`。
   - `MermaidRendererHost` 挂载在窗口可视区外（`left: -10000, top: -10000`），优先从本机 VS Code / Cursor / Antigravity 的 `xicilion.markdown-viewer-extension-*` 扩展提取离线 Mermaid bundle 缓存到 `/tmp/aed-mermaid/mermaid-docu-bundle.js`，缺失时回退 CDN。
   - 渲染生成的 SVG 经 `inlineForeignObjects()` 将 HTML 标签转为原生 `<text><tspan>`（避免 `<canvas>` 污染断图），再按 2x Retina 缩放绘制到 Canvas 导出 PNG Base64，回传主线程转为 `blob:` URL 交由 `<Image />` 展示。

---

## 内置 PTY 终端与 Ghostty 配置探测

- **无需 Rust 原生扩展的真 PTY**：`src/TerminalPane.tsx` 使用 `process.spawn("python3", ["-u", "-c", PY_PTY_SCRIPT, shellPath, termProgram, ghosttyResourcesDir], { cwd, stdin: "pipe" })`，在 Python 标准库中调用 `pty.fork()` 与 `termios.TIOCSWINSZ`（32×140）启动登录 Shell（`execvp(shell, [shell, "-l"])`）。
- **流式 ANSI 解析与半截转义序列拼接**：`extractProcessableChunk()` 使用 `INCOMPLETE_ANSI_TAIL` 缓存跨 chunk 截断的 ESC/CSI/OSC 序列，剥离非 CSI 控制码，处理 `\r` 行内覆盖、`\b` 退格、`CSI K` 清行与 `CSI 2J`/`3J` 清屏，每个会话保留最近 `1000` 行输出。
- **Ghostty 与 Shell 环境继承**：启动时 `discoverTerminalEnvironment()` 扫描 `~/.config/ghostty/config*` 与 `~/Library/Application Support/com.mitchellh.ghostty/config*`，自动继承用户的 `font-family`、`font-size`、`theme` 与 `command`，并探测本机已安装的 `zsh`、`fish`、`nu`、`bash`、`sh` 供终端顶栏下拉切换。

---

## Finder 桥接与打包流水线

`nsh package --target macos` 生成的基础 Runner 默认不处理 macOS Finder 的 `application:openFile:` / `application:openFiles:` / `application:openURLs:` 事件，也不解析命令行传入的文件路径。`scripts/package-macos.sh` 通过 3 个原生组件补齐完整桌面体验：

1. **`scripts/launcher.c`（主可执行文件 `Contents/MacOS/Aed`）**：
   - 原 `Aed` 二进制被重命名为 `AedCore`。
   - `launcher` 解析命令行参数：目录参数写入 `AED_ROOT`，文件参数写入 `AED_OPEN_FILE` 并追加到 `/tmp/aed-open.queue`，随后设置 `DYLD_INSERT_LIBRARIES=@executable_path/libFinderBridge.dylib` 并 `execv("AedCore")`。
2. **`scripts/finder_bridge.m`（`libFinderBridge.dylib`）**：
   - 在 `__attribute__((constructor))` 初始化时**立即调用 `unsetenv("DYLD_INSERT_LIBRARIES")`**（防止用户在内置终端里运行的子进程继承该环境变量导致崩溃或告警）。
   - Method Swizzle `NSApplication setDelegate:`，向宿主 Delegate 动态注入 `application:openFile:`、`application:openFiles:`、`application:openURLs:` 与 `windowWillResize:toSize:`，将 Finder 双击或拖拽打开的文件路径写入 `/tmp/aed-open.queue`，并在 AppKit 层锁定主窗口最小尺寸为 `760 × 520`（`setContentMinSize:` / `setMinSize:`）。
3. **`scripts/set_default_handlers.m`**：
   - 先通过 `LSCopyDefaultRoleHandlerForContentType` 查询当前默认打开程序，已绑定 `dev.byronwayne.aed` 的 UTI 直接跳过（避免重复触发 macOS `CoreServicesUIAgent` 确认弹窗），并对 UTI 去重、过滤未声明的 `dyn.*` 动态 UTI。
   - 默认仅注册 8 个核心文档与数据 UTI（Markdown、Mermaid、JSONL、JSON、CSV、TSV、Plain Text、Diff/Patch）；传入 `--all` 时额外注册常用源码 UTI，也可直接传入指定扩展名（如 `set_default_handlers yaml toml`）。
4. **跨版本 macOS 兼容性锁定（`LSMinimumSystemVersion = 11.0` + `LC_BUILD_VERSION` `minos = 11.0.0`）**：
   - `scripts/package-macos.sh` 统一设置 `MACOSX_DEPLOYMENT_TARGET=11.0` 并为所有 `clang` 编译命令传 `-mmacosx-version-min=11.0`，同时将 `Info.plist` 的 `LSMinimumSystemVersion` 设为 `"11.0"`，并将 `Contents/MacOS/` 下全部 Mach-O 二进制的 `LC_BUILD_VERSION`（`cmd = 0x32`）归一化为 `minos = 11.0.0`、`sdk = 14.0.0`。
   - `install.sh` 在用户机器落盘 `/Applications/Aed.app` 后，同样执行 `Info.plist` 与 Mach-O `LC_BUILD_VERSION` 归一化及本机 `codesign --force --deep --sign -` 重签名，再调用 `lsregister -f` 刷新 LaunchServices 缓存，确保在 macOS 11+ 全系列 Apple Silicon 系统上 `open /Applications/Aed.app` 均不会触发 `-10825`（`kLSIncompatibleSystemVersionErr`）。

---

## 界面设计语言（Industrial）

参照瑞士 / 包豪斯海报：纸、墨、一个信号红、石灰。默认主题 `industrial-paper`（浅）与 `industrial-carbon`（深）；其它 6 套主题沿用同一套结构规则，只换颜色。

| 规则 | 做法 | 代码位置 |
|---|---|---|
| 色面分区，不画线 | 标题栏（`32pt`）、标签栏（`36pt`）、面包屑栏（`28pt`）、侧栏（`240pt`）、编辑区、终端栏（`32pt`）、状态栏（`24pt`）与 Mermaid 容器全部对齐 `4px` 网格并靠底色深浅（`background` / `sidebar` / `card`）区分；不加 `border-b` / `border-t` / 标签间竖线。浮层（下拉、命令面板、设置弹窗、底部浮动控制条）用阴影，不用描边 | `App.tsx`、`src/Sidebar.tsx`、`src/TerminalPane.tsx`、`src/PreviewPane.tsx`、`src/mermaid.tsx` |
| 只有一个强调色 | `ui.accent`（信号红）只标「当前」：编辑器与终端活动标签顶部 `2px` 条、未保存圆点、光标、拖拽分隔条、Recent 序号、音频图标与选中勾号。文件类型徽章一律跟随 `ui.mutedForeground`，不按扩展名上彩虹色；Mermaid 渲染器直接注入当前主题 `ui` 色板，消除默认黄/紫底色 | `TabItem`、`TermTabChip`、`src/icons.tsx` `FileBadge`、`src/mermaid.tsx` |
| 状态栏是一块只读实色 | `ui.statusBar` / `ui.statusBarForeground`（Industrial Paper 上为墨色底、纸色字）；未设置时回退 `sidebar` / `mutedForeground`。左侧仅在当前工作区确属 Git 仓库时显示分支名，右侧仅显示当前文件只读元数据（路径、大小、行列或媒体尺寸），不放刷新或主题/字体切换按钮以免在终端输入区与窗口底边误触 | `StatusBar` |
| 欢迎页是一张海报 | 3 个平面：右侧红色拱形、左下墨色块（它本身就是「Open Folder」主按钮）、两者交界处的石色 1/4 圆。标题 `Aed` 采用 `Helvetica Neue` 粗体、紧字距单行展示；标签采用 Sentence case（`Recent`）。窗口最小尺寸锁定为 `760×520pt`（`MIN_WINDOW_WIDTH` / `MIN_WINDOW_HEIGHT` + AppKit `NSWindow.minSize`），`posterGrid()` 对画布尺寸施加 `520×380pt` 结构下限并按列宽与顶栏净空约束字号，保证标题绝不拆词折行、文字不压到色块上 | `App.tsx` `PosterFields` / `WelcomePanel`、`scripts/finder_bridge.m` |
| 颜色跟随主题重绘 | `Canvas` 只在 `draw` 内读到的 signal 变化时重绘，所以主题色必须在 `draw` 里读（`Icon` 的 `tint` 与 `AppLogo` 的 `ink` / `accent` 均支持传 accessor） | `src/icons.tsx` `Icon` / `AppLogo` |

**为什么 `nsh.json` 的 `theme.cssVars` 也是 Industrial**：`nsh 0.3.0` 的 TS 应用不能在运行时改 design tokens（`set_tokens` 只在 Rust 侧暴露，`~/.nsh/source/crates/nsh-js/src/env.rs`），`bg-primary`、`text-muted-foreground` 等类名永远取 `nsh.json` 里的静态值。以前这里是中性灰 + 白色 `primary`，所以主题切到暖色时出现「黑白两套颜色」。现在静态 tokens 与默认主题同色；需要跟随其它主题的界面元素，用 `style` 读 `theme.ui.*`，不用 token 类名。

---

## 关键决定与踩坑记录（Verified Facts & Traps）

1. **`nsh 0.3.0` 桌面无头测试平台参数**：
   - `nsh/test` 的 `open("./App.tsx")` 默认使用 `{ platform: "ios", width: 390, height: 844 }`，会禁用 `fs/promises` 与 `process`。在 `App.test.tsx` 中必须显式传入 `{ platform: "macos", width: 1280, height: 800 }`。
2. **`process.run` / `process.spawn` 必须显式传 `{ cwd }`（`nsh 0.3.0`）**：
   - 未配置宿主 `dataDir` 时省略 `cwd` 会直接抛错；且 `cwd` 必须落在 `nsh.json` 的 `capabilities.fs.write` 授权目录内（`${homeDir}` 或 `/tmp`）。`nsh.json` 中绝不能写 `~` 或 `$HOME`，必须写 `${homeDir}`。
3. **JSX 标签与内置控制流（`nsh 0.3.0`）**：
   - 所有组件标签必须大写开头（`<View>`、`<Text>`）；小写 HTML 标签编译失败。`<If when={...}>` 与 `<Each of={...}>` 是编译器注入的全局宏，**严禁从 `"nsh"` 导入**。
4. **冷启动绝不自动扫描 `$HOME` 或 `/`，且支持随时关闭工作区返回开屏页**：
   - 早期版本在未传工作区时回退 `os.homedir()`，导致应用一启动就递归扫描用户主目录并卡顿。现 `getInitialWorkspaceRoot()` 在无显式工作区时返回 `""`：若 `Storage` 尚无历史工作区记录（首次启动），隐藏左侧文件树并渲染瑞士网格开屏页 `WelcomePanel`（`id:welcome-panel`）；若 `aed.recentWorkspaces` 已有存在的工作区目录，冷启动时自动恢复最近一次工作区 `recentWorkspaces[0]`。
   - 一旦工作区已打开（`workspaceRoot().length > 0`）且当前无打开的 Tab（`activeFile() === undefined`），编辑区渲染安静的低对比度快捷键提示页 `EmptyEditorPanel`（`id:empty-editor-panel`）；用户可随时通过 `Close Folder`（`⌘⇧W`、菜单栏 `File ▸ Close Folder`、命令面板、侧栏顶部关闭按钮 `id:sidebar-close-folder` 或空态页 `id:empty-editor-close-folder`）将 `workspaceRoot` 置空并重置工作区状态，随时返回 `WelcomePanel` 开屏页。
   - 左侧文件树顶部目录名（`id:sidebar-workspace-title`）为纯静态标题展示，绝不绑定 `osascript` 选目录弹窗，避免误触文件树顶部时弹出系统模态窗；切换/打开目录仅通过菜单栏、`⌘O` 或侧栏右侧独立小图标（`id:sidebar-open-folder`）触发。
   - 单独打开外部文件（Finder 双击、拖拽文件或 `AED_OPEN_FILE`）仅以独立 Tab 打开，不篡改当前 `workspaceRoot`，也不将文件父目录写入 `aed.recentWorkspaces`；关闭或切换含未保存修改（`dirty`）的 Tab/工作区时弹出确认框（`id:unsaved-changes-dialog`）。状态栏仅在当前工作区确属 Git 仓库（`branch` 非空）时展示分支名，绝不在非 Git 目录伪造 `main`。
5. **`DYLD_INSERT_LIBRARIES` 泄漏坑**：
   - 若不在 `finder_bridge.m` 的构造函数里立即 `unsetenv("DYLD_INSERT_LIBRARIES")`，内置 PTY 终端里启动的所有 macOS 系统命令都会尝试加载 `libFinderBridge.dylib`。
6. **`nsh/base` 无样式原语（`Select` / `Command` / `Tree`）必须传完整浮层与行渲染**：
   - `Select` 原生不带任何背景、边框或字色（默认字色为纯黑 `#000000`）。使用时必须显式传入 `placement`、`popupClass` / `popupStyle` 及 `renderItem`（显式指定主题 `foreground` 字色、字体与选中/高亮态背景），否则在深色主题下会出现「透明底 + 黑字」悬浮现象。
7. **LaunchServices `_LSOpenURLsWithCompletionHandler() failed with error -10825` 兼容性坑**：
   - 在高版本 macOS SDK（如 macOS 27.0）机器上运行 `clang` 编译 `launcher.c`、`finder_bridge.m`、`set_default_handlers.m` 时，若未显式指定 `-mmacosx-version-min=11.0`，生成的 `Contents/MacOS/Aed` 主可执行文件 `LC_BUILD_VERSION` 会写入 `minos = 27.0.0`。低版本 macOS 的 LaunchServices 在执行 `open /Applications/Aed.app` 时检查主二进制 `minos` 与 `Info.plist` `LSMinimumSystemVersion`，直接报错 `-10825`（`kLSIncompatibleSystemVersionErr`）。必须在编译、打包及 `install.sh` 中将 `LSMinimumSystemVersion` 与 `LC_BUILD_VERSION.minos` 统一锁定为 `11.0`。

---

## 试过不做的方案（Tried & Rejected）

- **混合 Rust 模板（`--template mixed`）**：实测首次 `nsh test` 编译耗时 70s、二进制达 192 MB，且多 Agent 并行时 Cargo 锁冲突严重；纯 TSX（`--template ts`）配合 Python `pty.fork()` 与轻量 C/ObjC 包装即可满足全部原生能力，`nsh check` 仅 0.2s、`nsh test` 仅 1.0s。
- **使用 `qlmanage` + 底部外部打开操作栏预览 PDF**：`qlmanage -t` 在部分系统环境下会弹窗或阻塞，且底部常驻 `Open in Preview` 操作栏喧宾夺主；已改为直接调用 macOS 内置 `sips -Z 1800 -s format png` 生成 2x Retina 预览图，并以暖白纸张底衬（`#f7f4ee`）+ 缩放控制条承载，避免透明底黑字在深色主题下不可读。
- **在底部 24pt 状态栏放置刷新图标与主题/字体切换按钮**：在非 Git 目录下左下角会留下孤立无文字的 `↻` 图标（语义不明），而右下角的主题下拉、字体下拉与单点循环切主题按钮紧贴终端输入行与窗口缩放边缘，极易误触切走配色或弹出大菜单；现 `StatusBar` 统一改为纯只读状态展示，主题/字体配置与工作区刷新统一走 `⌘,`（Preferences）、应用菜单与 `⌘⇧P` 命令面板。
- **在 Markdown 预览中用字符画（`mmd2txt`）替代矢量图**：终端适合字符画，但桌面 GUI 编辑器用户期望高分辨率图表；因此采用隐藏 `WebView` + SVG `<foreignObject>` 内联 + 2x Retina PNG 光栅化方案。

---

## 验证与基准（Verification & Benchmarks）

| 检查项 | 命令 | 基准指标（macOS arm64，`nsh 0.3.0`） |
|---|---|---|
| 类型检查 | `nsh check` | ~0.2s，0 errors |
| 单测与桌面无头 E2E | `nsh test --trace` | ~1.0s，覆盖 10 类文件预览、Mermaid 渲染、主题切换、Ghostty 解析与真 PTY 回显 |
| 桌面真机窗口测试 | `nsh test App.tsx --target macos` | AppKit 真机窗口逐步交互验证 |
| 打包体积与速度 | `nsh package --target macos` | 增量打包 ~64ms，`.app` 体积 ~37 MB |
