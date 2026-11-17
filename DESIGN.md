---
title: Aed 架构与模块契约
description: 基于 Native Shell (nsh 0.4.0) 的 macOS 原生多格式预览器、代码编辑器与内置 PTY 终端（Aed — Another Editor）架构、持久化契约与实测踩坑记录。
---

# Aed 架构与模块契约

## 术语与边界

Aed（Another Editor）是基于 `nsh 0.4.0` 构建的轻量级 macOS 原生文件预览器、编辑器与终端工作区：界面与业务是 TSX，终端是一个小 Rust crate（`native/`，`nsh.json` `"rust": "native"`）。

- **拥有边界**：
  - 工作区目录扫描（深度 ≤ 4，单目录上限 200 项，先去掉忽略项再截断；读不了的目录、超深目录与被截断的目录在文件树里各有一行说明，不显示成空目录）、Git 变更状态解析（`git status --porcelain=v1 -z -uall`）与单文件 Diff 预览。
  - 10 类文件路由与渲染：`code`、`markdown`、`mermaid`、`html`、`table`（CSV/TSV/JSONL）、`diff`、`image`（PNG/JPG/GIF/WebP/AVIF/SVG）、`video`、`audio`、`quicklook`（PDF）、`binary`（4 KB Hex + ASCII）。
  - 内置多标签真 TTY 终端（libghostty-vt 1.0.1 解析终端流，原生 AppKit 视图画屏收键，Rust `forkpty` 起 Shell）与本机 Ghostty 字体/Shell 自动探测。
  - macOS Finder 双击/拖拽打开文件桥接（`libFinderBridge.dylib` + `launcher.c`）与 UTI 默认处理程序注册（`set_default_handlers.m`）。
- **不拥有边界**：不做插件市场/扩展宿主，不做 LSP 语言服务器客户端，不自带网络后端服务。

### 进程权限白名单（`nsh.json` `capabilities.process.execute`）

只放 app 自己 `process.run` / `process.spawn` 的 4 个二进制：`git`（状态与 diff）、`python3`（读大文件开头的字节，见「文件大小上限」）、`sips`（PDF 预览图）、`osascript`（选目录）。终端里的 Shell 由 `native/` 的 Rust 代码 `forkpty` + `execve`（绝对路径）拉起，不经过 nsh 的白名单，所以不需要列 `zsh` / `bash` / `sh`。新增一个 `process.run` 调用时，同时改这个列表和 `App.test.tsx` 里的最小权限断言。

### 网络与网页权限（`nsh.json` `capabilities.network` / `webview`，I-018）

两项都是 `{ "hosts": [] }`：App 不联网，也不显示任何远程网页。依据（`nsh 0.4.0` 文档「Sandbox and capabilities」与 `nsh-core` `access.rs`，并用整套 `nsh test --trace` 核对没有任何 `is not granted` 拒绝）：

- `webview.hosts` 只管 WebView 的 `src` 与顶层跳转。`"webview": { "hosts": [] }` 仍允许 `html` 内联页面与 `about:blank`，所以 Markdown / Mermaid 统一沙箱预览页与 `.html` 预览都不受影响（终端不用 WebView）；去掉整个 `webview` 键才会让 `html` 也被拒。页面自己的子资源（脚本、图片、XHR）不归它管，由各页面的 CSP 管。
- `network.hosts` 管 `fetch`、WebSocket、远程图片与视频源。`<Image>` 的 `blob:` URL 在进核心前已换成 `data:` 源（trace 里是 `data:image/png;nsh-key=…`），`<Video src={绝对路径}>` 不含 `://`，两者都按「app 自己的文件」放行（`allows_media`）。App 里没有 `fetch` / `WebSocket` / `net`。
- 需要联网的新功能（例如远程图片预览）要在这里写明原因，再把具体主机加进 `network.hosts`，不要再写 `*`。

### 持久化标识与 IPC 契约（不可随意改名）

| 类别 | 标识符 / 路径 | 用途与新旧兼容约定 |
|---|---|---|
| Bundle ID | `dev.byronwayne.aed` | `nsh.json` 与 `scripts/set_default_handlers.m` 共用；改名会导致 LaunchServices 默认打开关联失效 |
| `Storage` 键 | `aed.fontFamily` | 用户字体名；未设置时依次回退旧键 `native-editor.fontFamily`、Ghostty 配置或 `JetBrainsMono Nerd Font Mono` |
| `Storage` 键 | `aed.fontSize` | 字号（`9`–`28` 整数字符串）；未设置时回退旧键 `native-editor.fontSize`，非法值回退 Ghostty 字号或 `14` |
| `Storage` 键 | `aed.theme` | 主题 ID（8 套内置主题，默认 `industrial-paper`）；未设置时回退旧键 `native-editor.theme`，未知 ID 回退默认主题 |
| `Storage` 键 | `aed.shell` | 默认 Shell 绝对路径（如 `/bin/zsh`）；未设置时回退旧键 `native-editor.shell` |
| `Storage` 键 | `aed.recentWorkspaces` | JSON 字符串数组（最多保留最近 5 个显式打开的非 `/` 工作区目录，单独打开外部文件不写入）；未设置时回退旧键 `native-editor.recentWorkspaces`，解析失败回退 `[]`。App 启动时先读入已存列表，之后的记录（`AED_ROOT` 启动目录、切换目录）都排在读取之后（`rememberWorkspace`），不会用空列表覆盖它（I-017） |
| 环境变量 / Host 参数 | `AED_ROOT` / `NATIVE_EDITOR_ROOT` / `host.params.workspaceRoot` | 启动时初始工作区目录；均未设置时返回 `""`（直接展示 `WelcomePanel` 开屏页并列出 `Recent` 历史工作区供点击打开，绝不自动进入旧工作区或扫 `$HOME`、`/`） |
| 环境变量 / Host 参数 | `AED_OPEN_FILE` / `NATIVE_EDITOR_OPEN_FILE` / `host.params.openFile` | 启动时直接以无文件树（`workspaceRoot = ""`）独立窗口打开的第一个文件。带行号或列号时由 `launcher` 百分号编码为无歧义的 `file://<abs-path>#L<line>`（或 `#L<line>C<col>`）URI（避免磁盘上真有 `foo:10` 时 `foo:10:20` 被拼成 `/abs/foo:10:20` 产生二次剥离歧义；旧格式 `:line(:col)` 与纯绝对路径仍完全兼容），由 `resolveExternalFileReference()` / `parseTarget()` 解析跳转（不写入历史工作区）。`launcher` 启动时先清掉继承来的 `AED_OPEN_FILE` / `AED_ROOT` / `AED_OPEN_QUEUE` / `NATIVE_EDITOR_*`，只按本次参数重新设置（Aed 内置终端里的 Shell 和 `finder_bridge.m` 的 `open -n` 都会继承当前窗口的值） |
| 窗口标题标记（JS → 原生） | 标题以 ` — Edited` 结尾（`src/session.ts` `EDITED_TITLE_SUFFIX` / `windowTitle`，即 `Aed — Edited`） | JS 告诉 `finder_bridge.m`「有未保存修改」的唯一通道：有脏 Tab 时 App 把窗口标题设为 `Aed — Edited`，否则 `Aed`；用户同意退出后立即去掉标记，下一轮事件循环再 `process.exit`（`src/session.ts` `runApprovedQuit`，让新标题先生效）；`process.exit` 抛错，或 `QUIT_SETTLE_MS`（2 秒）后进程仍在（宿主取消了退出），标记按脏 Tab 恢复，保护重新生效。原生 → JS 不另设通道：原生选中 App 自己的 ⌘Q 菜单项（`Quit Aed`，`keyEquivalent` 为 `q` + Command 且 action 不是 `terminate:`）。两边的字面量必须一致（`src/session.test.ts` › the window title carries the edited mark scripts/finder_bridge.m reads）。旧版 dylib 不读标题、新版 dylib 遇到不带标记的旧 JS 都按宿主原行为退出，没有兼容负担 |
| 环境变量 / Host 参数 | `AED_OPEN_QUEUE` / `host.params.openQueue` | 本进程的 Finder 队列目录，`launcher` 在 `execv` 前设置，`libFinderBridge.dylib` 构造函数按 `getpid()` 重算并覆盖（不信任传入值）；`nsh.json` `process.env` 白名单需含此名。App 只接受形如 `<缓存目录>/open-<数字>` 的值（`resolveFinderQueueDir`，两边先 `path.normalize`：原生按 `$HOME` 原样拼接，`/Users/x/` 会得到 `//Library`），否则不读队列。`host.params.openQueue` 只供测试注入 |
| 每用户缓存目录 | `~/Library/Caches/dev.byronwayne.aed/`（`0700`） | Aed 自己的临时文件都放这里（`aedCacheDir()` / `scripts/aed_paths.h`）。原生代码用 `O_NOFOLLOW\|O_DIRECTORY` 打开后 `fstat` 校验：必须是真目录（不是符号链接）、属于当前用户，权限不是 `0700` 就改成 `0700`，否则放弃写入。App 侧 `fs/promises` 没有 `mode` / `chmod`，只在其下 `mkdir` 出 `ql/`，靠 `~/Library` 本身是 `0700`。WebKit 也把 Aed 的网页缓存放在同一目录的 `WebKit/` 下，两者互不干扰 |
| Finder 队列 | `<缓存目录>/open-<pid>/<seq>.path` | 每个 Aed 进程一个目录，每个待打开目标一个文件（无换行：无行号时为绝对路径，带行列定位或 URL 片段时为百分号编码的 `file://<abs-path>#L<line>[C<col>]`）。写入方先用 `O_CREAT\|O_EXCL\|O_NOFOLLOW`、`0600` 建 `.<seq>.tmp`，写完再 `renameatx_np(RENAME_EXCL)` 成 `<seq>.path`，所以读方看不到半截文件。写入方：`launcher`（命令行第 2 个起的文件）、`finder_bridge.m`（冷启动阶段收到的 AppleEvent，或运行态复用 `home`/`loose` 窗口时写入本进程队列）。读方：`consumeFinderOpenQueue()` 只认 `<数字>.path`，按数字（不是字典序）排序，逐个 `lstat`：普通文件读出内容，其它（符号链接等）不读，两者都删除（`unlink` 只删链接本身）；`.<seq>.tmp` 与 `state` 不碰。`launcher` 启动时清空本 pid 的旧目录，并删除进程已不存在的 `open-<pid>` 目录（是符号链接时只删链接） |
| 窗口模式状态文件（JS → 原生） | `<缓存目录>/open-<pid>/state`（`0600`） | 本进程当前窗口会话模式快照：`home`、`loose` 或 `workspace\n<root>`。`finder_bridge.m` 在非冷启动收到外部打开文件事件时，以 `O_NOFOLLOW` 只读检查本进程 `state`：若以 `home` 或 `loose` 开头且 `[NSApp mainMenu]` 中存在标题为 `"Open Queued Files"` 的菜单项，则将外部文件追加到 `getpid()` 的队列、触发 `"Open Queued Files"` 并置前当前窗口，复用现有空闲/无树窗口而不额外拉起 `open -n` 新进程；若 `state` 为 `workspace`、缺失、不可读，或菜单项尚未注册（旧版 JS 兼容），则回退 `open -n <Aed.app> --args …` |
| QuickLook 临时图 | `<缓存目录>/ql/<随机 UUID>.png` | `generateQuickLookUrl()` 让 `sips` 把 PDF 首页写成 PNG，读进内存转成 `blob:` URL 后立即删除 PNG（`sips` 失败也删）。内存里每个文件只留最新版本（`mtimeMs:size`）的 URL，新版本生成后 `revokeObjectURL` 旧的 |
| 环境变量 / 终端调试日志 | `AED_TERMINAL_LOG` · `<缓存目录>/terminal.log`（`0600`，超过 2 MB 改名为 `terminal.log.1` 后重开） | `native/src/lib.rs` + `native/src/log.rs`。生产环境默认关闭：仅当环境变量 `AED_TERMINAL_LOG` 显式设为非空值（如 `AED_TERMINAL_LOG=1`）且 `aed.terminal` 组件注册时才启用 `log::enable()`；未设置、为空或无头 `nsh test` / `cargo test` 均不打开文件、零磁盘 I/O。启用时逐行记录本地时间加：按键（keyCode、字符、修饰键、是否有输入法组字）、输入法 insert/mark/unmark、发给 Shell 的字节（控制字符转义）、Shell 输出前 240 字节、按键后 1.5 秒内光标所在行的格子内容、布局（视图尺寸、字体、格子尺寸、行列数）、焦点、链接、Shell 启动与退出。程序读密码时（PTY `ECHO` 关且 `ICANON` 开，即 `getpass` / `sudo` 的读法）只记字节数，不记内容。zsh/readline 在提示符下也关 `ECHO`，但它们关了 `ICANON`，不算读密码（`session::tests` › only_a_password_read_keeps_keys_out_of_the_log）。目录在打开日志时以 `0700` 创建，文件用 `O_NOFOLLOW` 打开并在内存中累计写入字节触发轮转。旧 `terminal.log` 文件在未开启 `AED_TERMINAL_LOG` 时保持原样不读写 |
| 测试 Shell 的私有目录 | `$TMPDIR/aed-shell-<pid>/`（`0700`，`std::env::temp_dir()`，macOS 上是每用户的 `/var/folders/…/T/`） | `native/src/pty.rs` `private_config`。只有 App 注册原生视图时调用 `pty::use_user_config()`，此后 Shell 用用户自己的启动文件和历史；之前（无头 `nsh test`、`cargo test`）每个 Shell 的 `ZDOTDIR` 和 `HISTFILE`（`<目录>/.history`）都指向这里，替换继承来的同名变量。macOS `/etc/zshrc` 无条件设 `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`，所以只设 `HISTFILE` 拦不住 zsh，要靠 `ZDOTDIR`；bash 认继承的 `HISTFILE`。效果：测试不再写用户的 `~/.zsh_history` / `~/.bash_history`（曾写入 4836 行），也不再加载用户的 `~/.zshrc`（oh-my-zsh 自动建议曾把测试命令当补全显示）。目录不删，留在系统临时目录里由系统清理。新增，无兼容问题（`session::tests` › a_shell_outside_the_app_keeps_its_history_out_of_home、`App.test.tsx` › test shells keep their history out of the user's home） |
| Mermaid bundle | 无磁盘缓存 | `loadMermaidBundleJs()` 每个进程直接从 VS Code / Cursor / Antigravity 扩展目录提取一次，结果只缓存在内存（没找到不缓存，下次渲染器启动再找） |
| Rust crate / 原生模块 | `nsh.json` `"rust": "native"`；模块 `aed/native`（`TerminalSession` 类、`setTokens`、`highlightCode`）；原生组件 `aed.terminal`（props `session` / `fontFamily` / `fontSize` / `theme`，事件 `focused` / `link`，命令 `focus`） | TSX 与 `native/src/lib.rs` 两边的字面量必须一致。原生组件只在 macOS 宿主注册，无头 `nsh test` 里是一个空视图。终端改原生时新增，没有旧缓存或配置要兼容 |
| 宿主事件（仅测试） | `aed.terminal.test` | `TerminalPane` 的测试通道，替代原生视图对当前 Tab 做的事（无头测试没有原生视图）：`{type:"input", data, binary?}`（当作键入，经启动闸门）、`{type:"resize", rows, cols}`、`{type:"focus", focused}`；第一次收到时打开纯文本镜像 `id:terminal-mirror`（最新 14 行）。打包宿主不发送；与 `aed.preview.eval` 同级。原名 `aed.terminal.page`（xterm 页面消息），只有测试用，改名无兼容问题 |

**旧 `/tmp` 路径（I-018 起废弃）**：`/tmp/aed-open.queue`、`/tmp/aed-ql/`、`/tmp/aed-mermaid/` 不再读也不再写。`/tmp` 所有人可写，其他本机用户可以预先放好符号链接或伪造内容，所以 Aed 也不去删除它们（删除本身会跟随别人放的链接）。升级后旧文件留在原处，用户可以手动 `rm`。新旧版本同时运行时互不影响：旧版本仍读写 `/tmp`，新版本只用每用户缓存目录。

---

## 结构与数据流

```text
+-----------------------------------------------------------------------------------+
| ● ● ●                       [ 🔍 native-editor (⌘P) ]                  [◧] [◨]   | <- WindowTitleBar (≥32pt, windowDrag)
+--------------------+--------------------------------------------------------------+
| fixtures   [❐] [⎇] | [M↓ README.md ×] [TS web/index.ts ×]   [Preview|Markdown|Diff]| <- SidebarHeader & TabStrip (36pt)
+--------------------+--------------------------------------------------------------+
| ▾ src/             | [ ! note.ts was moved or deleted.        [Save As…] [Close] ]| <- Priority NoticeBanner (0/36pt)
|     App.tsx      M +--------------------------------------------------------------+
|     classify.ts    |                 PreviewPane (按 FileKind 分发)               |
|     mermaid.tsx    |   Keyed Editor + FindBar (1/N) / Unified Markdown+Mermaid    |
|     tabs.ts        |   WebView / DataTable / Live DiffView / Scrollable Image /   |
|     ui.tsx         |   Video / Audio / QuickLook PDF / 4 KB Hex                   |
|                    +--------------------------------------------------------------+
|                    | [1: zsh ×] [2: zsh ×]                        [+] [zsh ▾]     | <- TerminalPane (TabStrip 32pt)
|                    | ➜ ~ echo NSH_PTY_OK_2026                                     |    native aed.terminal view, libghostty-vt per Tab
|                    | NSH_PTY_OK_2026                                              |
+--------------------+--------------------------------------------------------------+
| ⎇ main*            |                 README.md · 2.1 KB · Ln 1, Col 1 · markdown  | <- StatusBar (24pt, read-only)
+--------------------+--------------------------------------------------------------+
```

### 模块职责表（4 层最小单元架构）

| 层级 / 文件 | 核心导出 | 职责边界 |
|---|---|---|
| **L0** `src/target.ts` | `parseTarget`, `resolveTarget`, `normalizeDirPath`, `extensionOf` | 外部 CLI/Finder 引用、终端链接与 Markdown 相对链接的单一路径/行列/URI 归一化与安全协议过滤（无 UI） |
| **L0** `src/classify.ts` | `VIEWER_SPECS`, `badgeForPath`, `createLruCache`, `classifyFile`, `parseTableData`, `parseDelimitedRecords`, `parseJsonl`, `formatHexDump`, `probeImageDimensions`, `generateQuickLookUrl`, `createBlobUrl` | 11 种 `FileKind` 能力规格真源（`VIEWER_SPECS`）、通用有界 LRU 缓存（驱逐自动回调释放资源）、快速 CSV/TSV 与流式 JSONL/NDJSON 解析、4 KB Hex、PNG/GIF/SVG 尺寸探测、仅限 `.pdf` 的 `sips` 并发去重预览 |
| **L0** `src/themes.ts` | `EDITOR_THEMES`, `getThemeById`, `syncThemeTokens`, `computeSyntaxDecorations`, `decodeNativeSyntaxQuads`, `highlightSyntaxAsync`, `buildEditorThemeStyles` | 8 套配色主题（含 `accentForeground`、独立 `statusBar` 色面及 `400` 常规字重矿物语法色板，`industrial-paper` / `industrial-carbon` 区分 `function` 与 `type`）、通过 `aed/native` `setTokens` 实时同步 NSH 运行时设计 Token、首帧同步回退 + 后台阻塞线程 TextMate（`syntect` + `two-face` `3000` 行 UTF-16 跨行文法）语法高亮装饰器、与画布齐平的无色差行号栏样式 |
| **L1** `src/session.ts` | `WINDOW_TRANSITIONS`, `deriveWindowMode`, `deriveEditorSurface`, `planWorkspaceIntent`, `externalOpenKeepsTree`, `decideGuard`, `unsavedQuestion`, `nextActiveAfterClose`, `canToggleSidebar`, `serialize` | 窗口会话状态机纯规则（`home` / `workspace` / `loose`）、编辑区路由、未保存拦截与串行化执行器 |
| **L1** `src/saving.ts` | `saveInStore`, `settleSavedCopy`, `describeFailure` | 单 Tab 保存与并发输入结算纯规则（写入中继续打字不丢脏状态、已关闭 Tab 不回写、失败落 `saveError`） |
| **L1** `src/tabs.ts` | `createTabStore`, `applyTabLocation`, `tabLoadedFile`, `toLoadedFileSnapshot` | 每 Tab 独立会话状态仓库（`TabEntry`）：三态互斥 `diskStatus: "synced" \| "conflict" \| "missing"`、`reloadSeq`、每 Tab 光标/缩放/背景极性/滚动与 `blob:` URL 确定性回收 |
| **L1** `src/workspace.ts` | `statDisk`, `deferOutOfEffect`, `onceAsync`, `watchActiveInterval`, `syncWindowStateFile`, `isGitRepo`, `getInitialWorkspaceRoot`, `getInitialOpenFile`, `aedCacheDir`, `resolveFinderQueueDir`, `consumeFinderOpenQueue`, `resolveExternalFileReference`, `scanWorkspace`, `loadFile`, `loadTabFile`, `getPreloadedFile`, `warmWorkspaceFiles`, `reloadFromDisk`, `saveFileText`, `getFileDiffPatch`, `pickWorkspaceFolder`, `pickSavePath` | 工作区并发扫描（单趟收集文件与 Git 状态，非 Git 目录零子进程）、32 项小文件预热 LRU、生命周期感知自适应轮询（`watchActiveInterval`）、窗口模式状态文件同步（`state`）与磁盘读写 |
| **L1** `src/commands.ts` | `BUILT_IN_COMMANDS`, `runBuiltInCommand`, `buildQuickOpenItems`, `bindAppShortcuts`, `enforceMinWindowSize`, `setupDesktopChrome` | 内置命令表、全局快捷键、空工作区 Quick Open `Open Folder…` 兜底、窗口最小尺寸（`760×520`）与含 `"Open Queued Files"` 的原生应用菜单 |
| **L1** `src/workspaceSession.ts` | `createWorkspaceSession`, `computeTabModeItems` | 顶层工作区/Tab/轮询/Finder 队列会话控制器，向薄壳层 `App.tsx` 暴露响应式信号与动作 |
| **L2** `src/icons.tsx` | `Icon`, `FileBadge`, `opticalStrokeWidth` | `20×20` 统一视口矢量图标（恒定 `1.35pt` 屏幕描边补偿）与基于 `badgeForPath` 的单色文件徽章 |
| **L2** `src/ui.tsx` | `SurfaceButton`, `IconButton`, `TabStrip`, `tabStripRowClass`, `tabStripChipClass`, `TAB_STRIP_TRAILING_CLASS`, `disambiguateTabParents`, `SegmentedControl`, `ViewportPill`, `createZoom`, `NoticeBanner`, `resolveNotice`, `ModalShell`, `Keycap`, `formatShortcut` | 共享工业设计 UI 原语：带 `1px` 底边地平线与活动标签无接缝跨接（`-mb-px pb-px`）的同名 Tab 消歧标签栏、分段胶囊、浮动缩放条、单槽位 5 级优先级横幅、模态窗壳层与原生键帽 |
| **L3** `App.tsx` | `App` (mount root) | `<300` 行纯窗口壳层：标题栏、视口自适应边界夹紧的水平/垂直 `ResizablePanelGroup`、标签栏、编辑区、`StatusBar` 与弹层挂载 |
| **L3** `src/PreviewPane.tsx` | `PreviewPane`, `resolveEditorLayout`, `formatMediaMeta`, `formatSearchCount`, `clampRevealPosition`, `reconstructBaseFromPatch`, `resolveDiffInputs`, `resolveImageBackdrop`, `sortRows`, `withPreviewCsp` | 按 `FileKind` 分发渲染：按 `${tab.id}\0${reloadSeq}` 隔离撤销栈的非受控 `<Editor highlighting={false}>`（散文/Markdown 自动折行 `1.68x` 行高、源码不折行 `1.54x` 行高、`scrollBeyondLastLine={8}`）、带 `1px` 边框与 `1/N` 计数的 `FindBar`、支持未保存实时对比的 `DiffBody`、双向可滚动缩放的 `ImageBody`、`Intl.Collator` 排序的 `DataTable` 与 `.html` 严格 CSP 预览 |
| **L3** `src/MarkdownPreview.tsx` · `src/mermaid.tsx` · `src/markdownPage.ts` · `vendor/markdown/` | `MarkdownPreview`, `SandboxPreviewWebView`, `DiagramViewportPill`, `DiagramErrorBanner`, `buildMermaidConfig`, `preprocessMermaidCode`, `loadMermaidBundleJs`, `planPreviewRender`, `readImageDataUrl`, `buildPreviewShellHtml`, `handlePreviewMessage` | 统一沙箱矢量预览宿主：单个 keep-alive `WebView` 同时承载 `.md`（含内嵌 Mermaid 块、TOC、KaTeX、本地图片 Base64 LRU）与独立 `.mmd`（`50%–250%` 矢量缩放、复制源码与错误横幅），无第 2 个离屏 `WebView` |
| **L3** `src/WelcomePanel.tsx` · `src/PreferencesModal.tsx` | `WelcomePanel`, `EmptyEditorPanel`, `posterGrid`, `drawBauhausComposition`, `PreferencesModal`, `UnsavedChangesDialog` | 双栏瑞士 / 包豪斯展览海报开屏页（左栏顶底对齐 `Aed` 字标、`Recent` 台账与常驻 `Keycap` 快捷键条；右栏内嵌 `3×3` 方块与圆几何构成画布）、工作区空态页、偏好设置弹窗与未保存拦截对话框 |
| **L3** `src/Sidebar.tsx` | `Sidebar`, `CommandPalette` | `36pt` 顶栏对齐的文件树（纯图标 `files` / `branch` `IconButton` 过滤切换、$O(1)$ 展开集合、`Changed` 空状态与深层路径中间省略）与基于 `ModalShell` 的命令面板 |
| **L3** `src/TerminalPane.tsx` · `src/terminalTheme.ts` · `native/` · `vendor/ghostty-vt/` | `TerminalPane`, `discoverTerminalEnvironment`, `parseGhosttyConfig`, `createInputGate`, `linkTarget`, `buildTerminalTheme`, `TerminalSession` | 基于 `TabStrip` 的原生多标签 TTY 终端（libghostty-vt 1.0.1 + AppKit `aed.terminal` 视图 + Rust `forkpty`）、提示符就绪后静默高频输出通知（`setNotifyOutput(false)`）、`onceAsync` 并发环境探测与 `parseTarget` 链接跳转 |

---

## 状态机清单

Aed 的行为由下面 14 个状态机决定。「显式」表示状态与转移写在一处并有测试；「隐式」表示状态散在信号或模块变量里。改其中任何一个时，先改这张表。

### 窗口会话（显式，`src/session.ts`）

窗口模式由 `workspaceRoot`（`""` 表示没有工作区）和打开的 Tab 数推出，不另存一份：

| 模式 | 条件 | 界面 |
|---|---|---|
| `home` | 无工作区，无 Tab | `WelcomePanel` |
| `workspace` | 有工作区 | 文件树 + Tab；无 Tab 时 `EmptyEditorPanel` |
| `loose` | 无工作区，有 Tab | 无文件树的单文件窗口 |

转移表是 `WINDOW_TRANSITIONS`（`Record<模式, Record<事件, 模式>>`）。加模式或事件不补表，`nsh check` 报错；`src/session.test.ts` › every WINDOW_TRANSITIONS cell matches the rules App.tsx runs 用 App 调用的同一组函数重放每一格。规则：

- **重新打开当前目录**（`⌘O` 选同一目录、`Open Recent` 当前项、拖入当前目录）只刷新，保留 Tab（`planWorkspaceIntent` → `refresh`）。
- **拖入文件**（`drop-file`）表示「在这里打开」：不论文件在不在当前工作区内，都作为 Tab 打开，模式不变（有工作区则保留文件树）。**外部点击**（`click-file`：Finder / Herdr / `AED_OPEN_FILE`）一律进 `loose`，保持 I-007 规则。两者由 `externalOpenKeepsTree(origin)` 区分。
- **未保存确认框**只有两态：空闲、确认中。确认中时，新的受保护操作（关 Tab、`⌘⇧W`、切换工作区）直接丢弃（`decideGuard` → `busy`），不能替换用户正在回答的那个请求。问句按动作区分（`UnsavedGuard.action` → `unsavedQuestion`）：关 Tab「before closing?」、关文件夹「before closing the folder?」、切换文件夹「before opening another folder?」、退出「before quitting?」。选 `Save` 时任一文件保存失败：关掉确认框、不执行动作，切到那个 Tab，由它的保存失败横幅说明原因。
- **退出**（I-016）：`⌘Q` 是 App 自己的菜单项 `Quit Aed`（不再用 `role: "quit"`），命令面板 `File: Quit Aed` 走同一个 `actions.quit()`（`createQuit`）：有脏 Tab 先过未保存确认框，放行后 `process.exit(0)`。窗口红色关闭按钮与系统退出（Dock、注销、`osascript quit`）由 `finder_bridge.m` 在标题带 ` — Edited` 时转成选中 `Quit Aed`（见「Finder 桥接与打包流水线」）。用户放行后标记立即去掉，之后再来的退出请求（宿主自己的 terminate 路径）不再询问。
- 关 Tab 后激活剩下的最后一个 Tab，文件树选中项同步（`nextActiveAfterClose`），所以再点同一文件能重新打开。

### 其它状态机

| # | 状态机 | 状态 | 位置 | 现状 |
|---|---|---|---|---|
| 2 | 编辑区显示 | `file` / `welcome` / `workspace-empty` | `deriveEditorSurface` | 显式 |
| 3 | 文件与磁盘一致性 | `synced` / `conflict` / `missing`（三态互斥） | `src/tabs.ts` `TabEntry.doc.diskStatus`、`reconcileTabDisk`；`src/workspace.ts` `watchActiveInterval`、`statDisk`；`src/ui.tsx` `NoticeBanner` | 显式。每个 `TabEntry` 持有自己的 `diskStamp`（`mtimeMs:size`）与互斥三态 `diskStatus`：冲突中的 Tab 若源文件随后在磁盘上被删除，立即由 `conflict` 迁移为单一 `missing`（消除失效的 `Reload from Disk` 横幅）。`watchActiveInterval` 在窗口非活跃或无打开 Tab 时完全停表，每 `1.5s`（`DISK_CHECK_MS`）只做 1 次 `statDisk`（切到某 Tab 时立即检查，不重叠 `serialize`）。编辑区顶部只有单一 `36pt` 优先级横幅槽位（`resolveNotice`：`saveError > diskConflict > diskMissing > openError > readOnly`）：对已消失文件按 `⌘S` 显示更高优先级的 `id:save-error-banner`，点 `Dismiss` 后回落到 `id:file-missing-banner` |
| 4 | 单个 Tab 会话 | 加载中 → 干净 ⇄ 脏 → 关闭；保存：空闲 → 写入中 → 已保存 / `saveError`；模式 `preview` / `source` / `diff` | `src/tabs.ts` `createTabStore`（`TabEntry.doc` + `TabEntry.view`）；`src/saving.ts` `saveInStore`；`src/PreviewPane.tsx` `EditorBody` | 显式。`<Editor defaultValue>` 按 `${tab.id}\0${tab.doc.reloadSeq()}` 作为键挂载：每个 Tab 拥有完全独立的原生 `Buffer` 与 `⌘Z` 撤销历史（切 Tab 按 `⌘Z` 绝不跨文件串写），日常打字只做 $O(1)$ `tab.doc.text` 信号写入而不回传整份受控字符串；仅在外部磁盘重载或冲突 `Reload from Disk` 时递增 `reloadSeq` 重建编辑器。光标行列、缩放比例、图片底衬极性与待揭示行列均按 `TabEntry.view` 独立保存；关闭或重载 Tab 时自动 `revokeObjectURL` 旧 `blob:` URL |
| 5 | 统一沙箱预览宿主 | 未挂载 → Keep-Alive 挂载 → 按需注入 Mermaid bundle（`mermaidReady` / `mermaidUnavailable`） | `src/MarkdownPreview.tsx`、`src/mermaid.tsx` `SandboxPreviewWebView` | 半显式。`.md` 与独立 `.mmd` 共享唯一 keep-alive `WebView`（已退役旧离屏 `MermaidRendererHost` 第 2 个 `WebView`）：首次进入 `.md` 或 `.mmd` 预览时挂载，切到其它视图仅 `display:none` 隐藏而不销毁页面。需要 Mermaid 时由 `loadMermaidBundleJs()` 从本机编辑器扩展提取离线 bundle（纯内存缓存，无任何远程 CDN 回退） |
| 6 | 预览渲染调度与序号守卫 | `skip` / `immediate`（`0ms`）/ `debounce`（`120ms`）；图表 `loading` / `ready` / `error` | `src/MarkdownPreview.tsx` `planPreviewRender`、`vendor/markdown/page.mjs` `renderId` / `diagramSeq` | 显式。非预览模式打字零调度（`skip`），切文件或从源码切回预览立即下发（`0ms`），同文件连续编辑 `120ms` 防抖；页面按递增 `renderId` 与 `diagramSeq` 丢弃晚到的过期渲染结果 |
| 7 | 冷启动 | 先读 Recent（之后才记入启动目录）；两路并行：扫描初始目录（`refresh`）；打开初始文件 → 读 Finder 队列 → 读偏好 → 读 Ghostty 后再套一次主题 | `src/workspaceSession.ts` `bindColdStartAndQueueEffects` | 隐式，只跑一次 |
| 8 | Finder 队列 | 未配置即跳过 / 轮询中（`150ms × 16`，共 `2.4s`）+ `"Open Queued Files"` 菜单唤醒 | `src/workspaceSession.ts` `drainFinderOpenQueue`（`serialize`）、`src/commands.ts` | 显式。无 `AED_OPEN_QUEUE` 时零定时器开销；有队列时串行跑满 16 次轮询（不因首批取到提前停表，确保多批 Finder 打开不漏文件），运行态在 `home` / `loose` 窗口经 `"Open Queued Files"` 菜单项原地复用 |
| 9 | 终端会话 | 未启动 → 启动中（输入排队）→ 运行（未用 / 已用，提示符就绪后静默输出唤醒）→ 退出即关 Tab | `src/TerminalPane.tsx` `TermTab`、`createInputGate`、`session.setNotifyOutput` | 半显式。面板首次显示才启动 Shell；启动闸门放行后且未开启测试镜像时调用 `session.setNotifyOutput(false)`，避免 `yes` / 大编译输出在后台产生每秒数万次 Tokio⇄JS 事件唤醒（原生 `aed.terminal` 视图仍直接重绘，测试通道启用镜像时自动恢复 `true`）。未用过的 Shell 跟随目录，用过的保留目录与进程；Shell 退出关掉对应 Tab，最后一个退出自动收起面板 |
| 10 | 浮层 | 命令面板（关 / `files` / `commands`）、偏好设置、未保存确认框、查找栏（含 `1/N` 匹配计数） | `ModalShell`（`Dialog`）、`PreviewPane` `FindBar` | 隐式。`CommandPalette`、`PreferencesModal` 与 `UnsavedChangesDialog` 统一由 keep-alive `ModalShell` 承载；查找栏只属于编辑器视图，实时绑定 `<Editor onSearchChange>` 显示等宽数字 `1/N`（无匹配 `0/0`）与上/下一处按钮，且切换编辑器实例时按引用比对清理（避免旧实例卸载清空新实例引用） |
| 11 | 文件树视图 | `all` / `changed`，展开项（$O(1)$ `Set`），选中项 | `src/Sidebar.tsx`、`src/workspaceSession.ts` | 隐式。扫描按 `scanGen` 与根目录双重校验丢弃过期慢扫描；`Changed` 为空时按 `branch` 区分提示「`No uncommitted changes`」或「`Not a Git repository`」，深层相对路径启用 `ellipsis-middle` 保留文件名可见 |
| 12 | 窗口最小尺寸与分栏夹紧 | `760 × 520` 窗口下限 + 视口自适应侧栏/终端上限 | `src/commands.ts` `enforceMinWindowSize`、`App.tsx` `clampPanelMax` | 显式。侧栏最大宽度随 `windowSize().width - 520` 动态收缩，终端最大高度随 `windowSize().height - 316` 动态收缩，窗口缩到最小时绝不挤扁中央编辑区 |
| 13 | 偏好设置与运行时 Token | 默认值 → 已存值 → Ghostty 补齐 → `syncThemeTokens` | `src/workspaceSession.ts` `initUserPreferences`、`src/themes.ts` `syncThemeTokens` | 显式。切换任一主题立即调用 `setColorScheme` 与 `syncThemeTokens` 更新 NSH 全局语义色 |
| 14 | 工作区与磁盘一致性 | 未变（`2s → 5s → 10s` 退避）/ 目录变了（重扫回 `2s`）/ 仅 Git 变了 / 根目录不可用 | `src/workspaceSession.ts` `bindWorkspaceDiskPoller`、`src/workspace.ts` `watchActiveInterval` | 显式（I-014）。窗口 `active` 且有工作区时按 `2s → 5s → 10s` 自适应退避检查根目录与已展开目录 `mtimeMs`，窗口切后台立即停表、回到前台立即重扫；目录戳未变且 `snapshot.isGitRepo` 为真时才跑 `git status`（普通非 Git 文件夹零子进程开销）。同目录单进单出自动迁移展开项、选中项与打开的 `TabEntry` |

---

## 文件预览与 Mermaid 渲染契约

1. **类型判定、并发预热与大文件保护（`src/classify.ts` + `src/workspace.ts` + `src/themes.ts`）**：
   - `scanWorkspace()` 并发执行 `isGitRepo()` 守卫下的 `readGitStatus()`、`readGitBranch()` 与跨子目录 `Promise.all` 递归扫描（单趟 `collectFiles` 收集扁平列表），并在扫描完成后异步调用 `warmWorkspaceFiles()` 预热前 12 个 `≤ 256 KB` 且满足 `VIEWER_SPECS[kind].canPrewarm` 的小文件（32 项有界 LRU）；点击文件树时通过 `getPreloadedFile()` 同步命中内存缓存，实现 `0ms` 瞬时打开与切换。
   - **双层无闪烁 TextMate 语法高亮（`native/src/highlight.rs` + `src/themes.ts` + `src/PreviewPane.tsx`）**：`<Editor>` 显式传 `highlighting={false}` 关闭 `nsh-base` 内置硬编码 Allsum 色板（消除紫 `#c4a7ff` / 霓虹青 `#6fd3d8` 与应用主题色的双高亮冲突）；首帧挂载同步运行 `computeSyntaxDecorations()`（支持 Python 多行 `"""`/`'''`、`@decorator` 与关键字优先判定，零未着色白闪），同时异步调用 `highlightSyntaxAsync()` 经 `aed/native` `highlightCode` 在 `nsh_core::prelude::blocking` 工作线程上以 `syntect` 5.3 + `two-face` 0.4.5（`OnceLock<SyntaxSet>`，上限 `3000` 行 / `16000` 项）逐行解析最内层 TextMate 作用域（支持 Python 多行 docstring 斜体注释、`f"hello {user.name}"` 插值内层表达式阻断拆分、装饰器、类型注解与 CJK/Emoji UTF-16 列偏移），并以主题无关的 `NATIVE_QUADS_CACHE`（48 项有界 LRU）缓存四元组 `[line, startCol, endCol, role]`（切主题毫秒级重解码，连续打字 16ms 防抖加 `reqSeq` 过期丢弃）。代码 token 统一采用清晰等宽 `400` 常规字重（避免 `600` 半粗体笔画糊连，仅注释与 docstring 使用 `italic`）。
   - CSV / TSV / JSONL / NDJSON（`parseDelimitedRecords()` + `parseJsonl()`）：不含引号走快路径；含引号时对引号内连续明文区间按 `slice` 成段拷贝而非逐字符拼接；`parseJsonl()` 基于 `indexOf("\n")` 流式扫描（支持 `.jsonl` 与 `.ndjson`），截断大文件尾部半截行自动丢弃，非对象坏行记入 `TableData.invalidLines` 并展示 `id:table-invalid-lines`；列排序统一采用 `Intl.Collator`。`generateQuickLookUrl()` 仅对真实 `.pdf` 调用 `sips`（16 项有界 LRU + 同版本在途并发去重，驱逐自动 `revokeObjectURL`，临时 PNG 读完即删）。
   - `.html` 预览（`PreviewPane` `preview-webview`）：`javaScriptEnabled={false}`，并由 `withPreviewCsp()` 在页面最前（有 doctype 时紧跟其后）插入 CSP `<meta>`：`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'`。浏览器同时执行页面里所有 CSP，页面自己再写的 CSP 只能更严、不能放宽。所以本地 HTML 里引用的远程脚本、图片、样式表都不加载（不向外发请求），只显示文件本身。
   - `video`（`.mp4`, `.mov`, `.m4v`, `.webm`）、`audio`（`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`）与 `.pdf`（`quicklook`）在 `loadFile()` 中只调用 `statDisk()` 获取字节数，按路径预览（`<Video src={filePath} />`、`sips`），绝不 `fs.readFile` 读入内存。
   - 图片（`.png`, `.jpg`, `.gif`, `.webp`, `.avif`, `.svg`）通过 `fs.readFile` 构造 `URL.createObjectURL(new Blob([bytes], { type }))`，由 `ImageBody` 包裹在双向 `<Scroll>` 容器内支持 `25%–400%` 缩放平移与按当前主题明暗自适应命名的底衬切换（`resolveImageBackdrop`）。
   - 未知扩展名文件按前 4 KB 判定，含 `\0` 字节则归类为 `binary`，展示只读 4 KB Hex + ASCII 视图。
   - **文本解码与保存回写（`src/workspace.ts` `decodeUtf8` / `encodeUtf8` / `saveFileText`）**：文本按 UTF-8 严格解码（`TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`，开头的 BOM 先剥掉并记在 `LoadedFile.bom`）。解码失败（GBK、Latin-1 等）时用替换字符显示，但副本标为只读（`readOnly = "Not UTF-8 — opened read-only"`）：编辑器 `readOnly`，编辑区上方显示 `id:read-only-banner`，永远不写回。保存写入 UTF-8 字节，`bom` 为真时先写回 BOM。保存后由新字节重算派生数据：表格行、SVG 的 `blobUrl` 与尺寸；`diffPatch` 清空（`.diff`/`.patch` 文件除外，它就是正文），下次进入 Diff 时重新拉取，保存时正处于 Diff 的 Tab 立即重拉。不透明类型从不写回（见「状态机清单」#4）。

### 文件大小上限

`src/workspace.ts` `readFileBytesFromDiskStat`（I-017）：`MAX_EDITABLE_BYTES = 8 MiB`（`nsh 0.4.0` `fs.writeFile` 最多写 8 MiB，更大的文件本来也存不回去）。不超过上限的文件整读。超过上限的非图片文件不整读：先读前 4 KB（`BINARY_HEAD_BYTES`）判定，二进制只留这 4 KB 给 Hex 视图；文本读前 256 KiB（`LARGE_TEXT_HEAD_BYTES`）只读显示，`readOnly = "Larger than 8 MB — showing the first 256 KB, read-only"`（`id:read-only-banner`，永不写回）。`nsh 0.4.0` 的 `fs/promises` 没有部分读取，所以开头的字节由已授权的 `python3` 读出、以十六进制经 stdout 传回（`readFileHead`）。图片仍整读（`blob:` 需要全部字节；`fs.readFile` 超过 64 MiB 会失败，失败显示在 `id:open-error-banner`）。

2. **能力驱动的模式分段控件（`src/workspaceSession.ts` `computeTabModeItems` + `src/classify.ts` `VIEWER_SPECS`）**：
   - 模式胶囊（`SegmentedControl`：`id:mode-preview` / `id:mode-source` / `id:mode-diff`）置于 `TabStrip` 右侧固定槽位（已移除冗余 `28pt` `EditorBreadcrumbBar`）。
   - 显示集合完全由 `VIEWER_SPECS[kind].modes({ mimeType, editable, hasDiff })` 决定（其中 `hasDiff = Boolean(gitStatus || diffPatch || dirty)`）：具备富预览能力的格式（`markdown`、`mermaid`、`table`、`html`、`image/svg+xml`）在有变更时同时提供 `[Preview | Markdown/Code | Diff]`；从 `Changed` 打开或编辑过的源码文件始终保留 `[Code | Diff]`，切到 `Code` 时 `[Diff]` 绝不消失；切到 `Diff` 且含未保存修改时，`resolveDiffInputs` 将实时缓冲区与 `HEAD` 基线（由 `reconstructBaseFromPatch` 反推或回退 `savedText`）直接对比。
3. **统一沙箱矢量预览契约（`src/MarkdownPreview.tsx` + `src/mermaid.tsx` + `src/markdownPage.ts` + `vendor/markdown/`）**：
   - `.md`（`id:preview-markdown`）与独立 `.mmd` / `.mermaid`（`id:preview-mermaid`）共享同一个 keep-alive 沙箱 `WebView`（`SandboxPreviewWebView`），彻底退役旧离屏光栅化 `WebView`、`<canvas>` 2x PNG 导出与任何远程 CDN 回退 URL。
   - `vendor/markdown/entry.mjs` 构建 markdown-it 15.0.3 管线（`html:true`、`linkify:true`、footnote / task-lists / CJK 安全去重 slug 的 anchor / GitHub alerts / highlight.js 11.12.0 common 子集 / KaTeX 0.19.1，`mermaid` 围栏保留为 `<pre class="mermaid">`），与 `page.mjs`（DOMPurify 消毒 + `window.__aed` 协议，同时支持 `render` 与独立图表 `renderDiagram`）经 `scripts/build-markdown-vendor.sh` 打进 `src/markdownVendor.generated.ts`（含 `buildId` 防漂移校验）。
   - 页面壳层 `buildPreviewShellHtml()` 延迟生成并缓存，只含严格 CSP（`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`）与样式，**0 个 `<script>`**；首帧由 `buildPreloadBgScript(bg)` 预涂主题背景色消除白闪，运行时在 `onLoad` 经 `injectJavaScript` 注入一次。
   - 协议：宿主下发 `__aed.render(...)`（Markdown）或 `__aed.renderDiagram({renderId, path, code, themeCss, mermaidConfig})`（独立 `.mmd`，`securityLevel: "strict"`）、`__aed.setTheme`、`__aed.setImages`、`__aed.mermaidReady`、`__aed.mermaidUnavailable` 及独立图表矢量缩放 `formatDiagramZoomScript(zoom)`；页面上行 `link`、`images`、`scroll`、`needMermaid`、`diagramRendered`、`copySource`。独立 `.mmd` 叠加 `DiagramViewportPill`（图表类型标签、`50%–250%` 矢量缩放与复制源码反馈）及 `DiagramErrorBanner`。
   - 本地图片由 `readImageDataUrl()` 按 `${path}\0${mtimeMs}:${size}` 缓存在 32 项有界 LRU 中（上限 20 MB），Markdown 编辑重渲时 $O(1)$ 命中内存而不重复读盘编码；滚动位置保存在 64 项有界 LRU `scrollMemory`。
   - TOC 仅当视口 ≥960px 且 ≥2 个 H1–H3 时显示（`body.aed-has-toc`）；`nsh 0.4.0` 无头 `nsh test` 不执行 WebView 页面 JS，真机 `--target macos` 仅在用户明确要求时运行。

---

## 内置 PTY 终端与 Ghostty 配置探测

终端是原生的：libghostty-vt 1.0.1（Ghostty 的终端解析库，C API）维护屏幕、滚动记录与模式，`native/` 的 AppKit 视图画屏、收键盘，Rust `forkpty` 给 Shell 一个真终端。中间没有 WebView、页面 JS 或桥接进程；TSX 只管 Tab 与规则（`src/TerminalPane.tsx`）。

- **会话（`native/src/session.rs` `TerminalSession`）**：一个 Tab 一个，`new TerminalSession(rows, cols)` 建一个 libghostty-vt 终端（滚动记录 10000 行，`TERM=xterm-256color`）。`start({shell, cwd, termProgram, resourcesDir})` 用 `forkpty` 以登录 Shell（`-l`）起进程：子进程先把信号恢复默认、清空信号屏蔽（App 是 Rust 程序，忽略 SIGPIPE，忽略状态会被 Shell 和它跑的每个程序继承，`yes | head` 会报 Broken pipe），给 TTY 打开 `IUTF8`（退格删整个汉字），`chdir` 或 `execve` 失败时经 close-on-exec 管道把 errno 交回，`start` 抛错（TSX 显示 `[error] …`），不会变成一个 exit 127 的会话；环境加 `TERM`、`COLORTERM=truecolor`、`TERM_PROGRAM`、`DISABLE_AUTO_TITLE=true`、`PROMPT_EOL_MARK=""`（有 Ghostty 时加 `GHOSTTY_RESOURCES_DIR`）；新 Shell 保留屏幕。读线程把 PTY 输出喂给终端，写线程把输入写进 PTY（不读输入的程序不会卡住输出）；终端要回给程序的应答（DA、光标位置等）由 libghostty-vt 的 `write_pty` 回调送回 PTY。
  - `nextEvent()` 依次给出 `output`（有新输出，合并）、`title`（OSC 0/2，显示为 Tab 名 `<id>: <title>`）、`exit`（退出码，信号为 128+n）、`input`（没有 Shell 时有键入：TSX 起一个新 Shell，这次的键丢弃）、`closed`（`close()` 后，不再有事件）。`stop()` 挂断 Shell，不发 `exit`。
  - `write(bytes)` 是用户键入：有 Shell 时写入并把会话标为 `used`（`start` 时清零）。`feed(text)` 把状态行（`[error] …`）直接写到屏幕，不进 Shell。`resize(rows, cols)`（行 1–500、列 1–1000）改 PTY 尺寸，Shell 收到 `SIGWINCH`；视图量出尺寸前是 32×140（`DEFAULT_ROWS` × `DEFAULT_COLS`）。`clear()` 是 ⌘K：去掉滚动记录与提示符以上的行。`reset()` 是全新屏幕（重启会话用），主题颜色保留。`screenText()` 给出屏幕与滚动记录的纯文本，软换行接回一行。
  - 线程：`TerminalSession` 的方法在引擎线程，视图在主线程，另有 PTY 读、写线程；共享状态在一把锁里（加锁顺序：终端 → 输入队列）。选区的格子引用只在同一把锁内有效，所以复制在同一次加锁里格式化。
- **视图（`native/src/view.rs`，原生组件 `aed.terminal`）**：只显示 `session` prop 指定的会话；会话有输出时唤醒视图，按 libghostty-vt 渲染状态的脏行重画。用 CoreText 画字（`fontFamily` 找不到时用系统等宽字体，字号缺省 12），格子尺寸按像素取整，四周留 6pt。视图尺寸一变就算出行列调用 `resize`。`theme` prop 是 `buildTerminalTheme(theme)`：`theme.ui` 的背景、前景、强调色（光标）、选区色，加 16 色 ANSI 调色板（`ANSI_PALETTES`，按上游配色，过淡的颜色调到在本主题背景上对比度 ≥3，前景 ≥4.5；没有自带调色板的主题从语法色推出）；字体：偏好设置 → Ghostty `font-family`；字号：偏好设置 → Ghostty `font-size` → 12。
  - 键盘：普通键经 libghostty-vt 的按键编码器（跟随终端当前的光标键、Kitty 键盘等模式；Option 不当 Alt）直接写进 PTY，不经过 TSX。`⌘` 组合键交还给 App 的菜单与 `keymap`。输入法走 `NSTextInputClient`：组字中的文字带下划线画在光标处，候选窗跟着光标，确认后才写入。
  - 鼠标：拖拽选择、双击选词、三击选行由 libghostty-vt 的选择手势处理；程序开了鼠标跟踪时（`vim`、`htop`）事件经鼠标编码器交给程序，按住 Shift 仍然是选择。滚轮：鼠标跟踪时交给程序；备用屏且开了模式 1007 时变成方向键；否则滚动查看记录（触控板按像素累计）。
  - 剪贴板：⌘C 复制选区，⌘V 粘贴（程序开了 2004 时加括号粘贴标记），⌘A 全选，都走菜单的 `copy:` / `paste:` / `selectAll:`。
  - ⌘-点击：OSC 8 超链接取其 URI，否则取点击处的词（去掉两端括号、引号与标点），发 `link` 事件。TSX `linkTarget(text, dir, home)` 判定：`http(s)://` 用 `openUrl` 打开，其它当作路径（去掉 `:行(:列)`，展开 `~`，相对路径按该 Shell 的启动目录解析），是普通文件才在 Tab 里打开。
  - 焦点：成为/失去第一响应者时发 `focused` 事件；程序开了 1004 时同时写焦点报告。终端有焦点时 `TerminalPane` 绑定 `mod+k`（清屏）与 `mod+f`（不做事）；`keymap` 同一按键只跑最新的那个绑定，所以此时 ⌘K 不打开 Quick Open、⌘F 不打开编辑器查找栏；失焦即解绑。
- **多 Tab**：一个视图，换 Tab 只换 `session` prop，所以每个 Tab 的屏幕与滚动记录都在自己的会话里，切换不丢。关 Tab 时 `close()` 会话。
- **工作目录与启动**：见「状态机清单」#9。新终端 Tab 在当前工作区启动（无工作区时 `~`）。「用过」= Shell 在跑且 `used`（原生视图里的键入）或测试通道键入过。
- **测试通道**：无头 `nsh test` 没有原生视图，所以宿主事件 `aed.terminal.test` 替它对当前 Tab 键入（经 `createInputGate` 启动闸门，见踩坑 #9）、改尺寸、报焦点，并打开纯文本镜像 `id:terminal-mirror`：每次 `output` 后取 `screenText()`，显示最新 14 行（每行一行高，保证都在屏幕内、`app.texts()` 读得到）。镜像只在通道用过后才更新，打包后的 App 不付这份开销。`App.test.tsx` 的 `runInTerminal(app, cmd, marker)` 走这个通道。原生视图本身的绘制、输入法、鼠标与滚轮无头测不到，只能真机核对；会话层由 `native/src/session/tests.rs` 的 Rust 测试覆盖（`nsh test` 一起跑）。
- **Ghostty 与 Shell 环境继承**：启动时 `discoverTerminalEnvironment()` 扫描 `~/.config/ghostty/config*` 与 `~/Library/Application Support/com.mitchellh.ghostty/config*`，继承用户的 `font-family`、`font-size` 与 `command`，并探测本机已装的 `zsh`、`fish`、`nu`、`bash`、`sh` 供终端顶栏下拉切换。

---

## Finder 桥接与打包流水线

`nsh package --target macos` 生成的基础 Runner 默认不处理 macOS Finder 的 `application:openFile:` / `application:openFiles:` / `application:openURLs:` 事件，也不解析命令行传入的文件路径。`scripts/package-macos.sh` 通过 3 个原生组件补齐完整桌面体验：

1. **`scripts/launcher.c`（主可执行文件 `Contents/MacOS/Aed`）**：
   - 原 `Aed` 二进制被重命名为 `AedCore`。
   - `launcher` 解析命令行参数：`file://[localhost]/…` 先剥离 `#L<line>[C<col>]` 片段与 `?query` 再做百分号解码（`%00` 不解码）；路径按「字面路径 → 剥 `#L<line>[C<col>]` → 剥单段 `:line` → 剥双段 `:line:col`」依次尝试 `realpath`，存在就不剥更多后缀（文件可以叫 `notes:12`，传 `notes:12:20` 可跳到它的第 20 行）。解析出 `line > 0` 时统一编码为无歧义的 `file://<percent-encoded-abs-path>#L<line>[C<col>]` URI 交给 App 跳转；无行号时直接写绝对路径。有文件参数时文件优先：第 1 个写入 `AED_OPEN_FILE`（清除 `AED_ROOT` / `NATIVE_EDITOR_ROOT`），第 2 个起写入本进程自己的队列 `open-<pid>`（`execv` 后 pid 不变），同一个窗口全部作为 Tab 打开；没有文件参数时第 1 个目录写入 `AED_ROOT`。随后设置 `DYLD_INSERT_LIBRARIES=@executable_path/libFinderBridge.dylib` 并 `execv("AedCore")`。
2. **`scripts/finder_bridge.m`（`libFinderBridge.dylib`）**：
   - 单一 `__attribute__((constructor))` 初始化时**立即调用 `unsetenv("DYLD_INSERT_LIBRARIES")`**（防止用户在内置终端里运行的子进程继承该环境变量导致崩溃或告警），并通过统一的 `neHookMethod` 挂接 `NSApplication setDelegate:` 及窗口/应用 Delegate 方法。
   - `application:openFile:`、`application:openFiles:`、`application:openURLs:` 与 `windowWillResize:toSize:`：
     - `application:openURLs:` 对带 `#fragment` 的本地 `file:` URL 保留完整 `[url absoluteString]`（如 `file:///path/a.ts#L42`），否则取 `[url path]`。
     - 一次打开事件（Finder 里选中 N 个文件）是一批：所有文件进同一个窗口作为 Tab，每个文件夹各开一个窗口。
     - **冷启动首个外部目标**（`NSApplicationDidFinishLaunching` 前及完成后 `1.5s` 内且未通过 `--args` 指定初始目标）：这一批文件全部写入本进程队列 `open-<pid>`（没有文件时写第 1 个文件夹）并唤醒当前窗口，由 `App.tsx` 以无文件树独立模式（`workspaceRoot = ""`）直接展示；
     - **运行中再次点击外部文件**：先只读检查 `<缓存目录>/open-<pid>/state`——若本窗口处于 `home` 或 `loose` 模式且 `[NSApp mainMenu]` 中存在 `"Open Queued Files"` 菜单项，则直接将文件写入 `getpid()` 队列、触发 `"Open Queued Files"` 并置前当前窗口；否则调用一次 `/usr/bin/open -n <Aed.app> --args <path1> <path2> …` 拉起独立 Aed 窗口进程（不带左侧文件树），并在 AppKit 层锁定窗口最小尺寸为 `760 × 520`（`setContentMinSize:` / `setMinSize:`）。
   - **退出保护（I-016）**：在 `NSApplicationDidFinishLaunching` / `NSWindowDidBecomeKey` 时给宿主窗口 Delegate 的 `windowShouldClose:` 与 App Delegate 的 `applicationShouldTerminate:` 各挂一次钩子（保存原实现，各类只挂一次）。窗口标题以 ` — Edited` 结尾时：关闭按钮返回 `NO`、系统退出返回 `NSTerminateCancel`，并在下一轮 run loop 选中 App 的 `Quit Aed` 菜单项，由 JS 弹未保存确认框；标题不带标记、或菜单里找不到该项时，调用宿主原实现，行为与以前相同。菜单项在下一轮 run loop 重新查找后再触发（App 可能在此期间重建菜单）。**JS 无响应兜底**：上次转交后 4 秒内（`AED_QUIT_RETRY_SECONDS`）又来一次关闭或退出、标题仍带标记时，弹原生 `NSAlert`「Quit Aed without saving?」（`Cancel` / `Quit Anyway`），选 `Quit Anyway` 走宿主原实现，避免页面卡死时只能强制退出。无头测试测不到原生部分，需要 `--target macos` 或打包后手测。
3. **`scripts/set_default_handlers.m`**：
   - 先通过 `LSCopyDefaultRoleHandlerForContentType` 查询当前默认打开程序，已绑定 `dev.byronwayne.aed` 的 UTI 直接跳过（避免重复触发 macOS `CoreServicesUIAgent` 确认弹窗），并对 UTI 去重、过滤未声明的 `dyn.*` 动态 UTI。
   - 默认仅注册 8 个核心文档与数据 UTI（Markdown、Mermaid、JSONL、JSON、CSV、TSV、Plain Text、Diff/Patch）；传入 `--all` 时额外注册常用源码 UTI，也可直接传入指定扩展名（如 `set_default_handlers yaml toml`）。
   - 只在用户显式要求时运行：`sh scripts/package-macos.sh --set-default`、`sh install.sh --set-default`，或 DMG 里的 `Install & Set Default.command`（普通安装绝不自动接管默认文本编辑器）。
   - `Info.plist` 的 `CFBundleDocumentTypes`：文本、源码、Markdown、JSON、CSV 等具体类型为 `Editor` / `Default`；`public.data`（任意文件）单独一组，为 `Viewer` / `Alternate`，只让 Aed 出现在「打开方式」里，不声明自己是所有文件的默认编辑器。
4. **单源打包校验与跨版本 macOS 兼容性锁定（`LSMinimumSystemVersion = 11.0` + `LC_BUILD_VERSION` `minos = 11.0.0`）**：
   - `scripts/package-macos.sh` 是唯一的 `.app` 补丁源：统一设置 `MACOSX_DEPLOYMENT_TARGET=11.0` 并为所有 `clang` 编译命令传 `-mmacosx-version-min=11.0`，将 `Info.plist` 的 `LSMinimumSystemVersion` 设为 `"11.0"`，将 `Contents/MacOS/` 下全部 Mach-O 二进制的 `LC_BUILD_VERSION`（`cmd = 0x32`）归一化为 `minos = 11.0.0`、`sdk = 14.0.0`，签名并执行 `codesign --verify --deep --strict`。传入 `--build-only`（可配合 `--skip-tests`）时在完成 `.nsh/out/Aed.app` 构建与签名校验后直接退出，不写 `/Applications`、不调 `lsregister`/`set_default_handlers`、不打 DMG/ZIP。
   - `install.sh` 下载已补丁的发布归档落盘 `/Applications/Aed.app` 后，仅清理扩展属性、调用系统 `codesign --force --deep --sign -` 重签名并刷新 `lsregister -f`，不再内联重复的 Mach-O / SuperBlob 补丁脚本；确保在 macOS 11+ 全系列 Apple Silicon 系统上 `open /Applications/Aed.app` 均不会触发 `-10825`（`kLSIncompatibleSystemVersionErr`）。

---

## 界面设计语言（Industrial）

参照瑞士 / 包豪斯展览海报：工作区界面用纸、墨、一个信号红（`ui.accent`）与石灰（`ui.border`）；开屏海报右侧几何画布额外配矿物朱砂、赭黄与钴蓝（`BAUHAUS_MINERALS`）。默认主题 `industrial-paper`（浅）与 `industrial-carbon`（深）；其它 6 套主题沿用同一套结构规则，只换颜色。

| 规则 | 做法 | 代码位置 |
|---|---|---|
| 色面分区，对齐顶栏 | 标题栏（`≥32pt`）、侧栏顶栏与编辑区 `TabStrip`（统一 `36pt`，`h-9`）、单槽位优先级 `NoticeBanner`（`36pt`）、侧栏（默认 `240pt`）、终端 `TabStrip`（`32pt`，`h-8`）与状态栏（`24pt`）全部对齐 `4px` 网格并靠底色深浅（`background` / `sidebar` / `card` / `statusBar`）区分；移除冗余 `28pt` 面包屑栏，同名打开文件由 `TabStrip` 自动补灰字父目录前缀（`web/index.ts`）。浮层（下拉、命令面板、设置弹窗、`ViewportPill`）用阴影承载 | `App.tsx`、`src/ui.tsx`、`src/Sidebar.tsx`、`src/TerminalPane.tsx`、`src/PreviewPane.tsx` |
| 只有一个强调色 | `ui.accent`（信号红，配 `ui.accentForeground` 保证对比度 ≥ 4.5:1）只标「当前」：编辑器与终端活动标签顶部 `2px` 条、未保存圆点、光标、激活拖拽分隔条（悬停 `accent+b3`、拖拽 `accent`、闲置 `border`）、Recent 序号与选中主按钮。文件类型徽章一律跟随单色 `muted-foreground`，按 `badgeForPath`（`VIEWER_SPECS` + 真实扩展名 `extensionOf`）派生；Mermaid 直接注入当前主题 `ui` 色板 | `src/ui.tsx` `TabStrip`、`App.tsx` `renderSplitHandle`、`src/icons.tsx` `FileBadge`、`src/mermaid.tsx` |
| 状态栏是一块只读实色 | 每套主题均定义专属 `ui.statusBar` / `ui.statusBarForeground`（与相邻 `sidebar` 终端底面清晰分层）。左侧仅在当前工作区确属 Git 仓库时显示分支名，右侧仅显示当前文件只读元数据（`loose` 模式显示 `shortenHomePath` 完整相对家目录路径；行列仅在 `editor` 视图显示；图片媒体尺寸仅在状态栏显示一份，不在 `ViewportPill` 重复） | `App.tsx` `StatusBar`、`src/workspaceSession.ts` `buildStatusSegments` |
| 欢迎页是双栏包豪斯方块与圆几何海报 | 左栏按上下边距 `pad` 顶底对齐（`justify-between`）：顶部放紧凑 `Helvetica Neue` `Aed` 字标（`56–84pt`，无口号副标题）与至多 5 行带右对齐父路径的 `Recent` 台账，底部基线常驻非点击静默键帽条（`⌘O Open folder` · `⌘P Quick open` · `⌘J Terminal`）；右侧内嵌不越界的 `3×3` 偶数像素网格正方形画布（`drawBauhausComposition`），以 `1px` `ui.border` 模数线框统领钴蓝同心光圈圆、墨/石相切四分之一圆转子、Albers 嵌套朱砂方块、赭黄内切圆及底部朱砂扇形—墨方圆孔—钴蓝扇形桥拱。不放「Open Folder」按钮防误触，纯开屏态（未打开终端）隐藏标题栏右上角侧栏与终端切换图标（保留 `60pt` 等宽占位使搜索框居中对称；无工作区的 `loose` 态亦隐藏无效侧栏图标），冷启动点顶栏 Quick Open 提供 `Open Folder…` 入口；窗口最小尺寸锁定 `760×520pt` | `App.tsx`、`src/WelcomePanel.tsx`、`src/commands.ts`、`scripts/finder_bridge.m` |
| 颜色跟随主题实时同步 | `Icon` 采用统一 `20×20` 视口与 `opticalStrokeWidth(size, 1.35)` 恒定屏幕线宽，并在 `Canvas` `draw` 内读取颜色 accessor；切换任一主题时由 `syncThemeTokens(theme)` 经 `aed/native` `setTokens` 实时更新 NSH 全局语义 token | `src/icons.tsx`、`src/themes.ts` `syncThemeTokens`、`native/src/lib.rs` |
| 预览阅读排版与 TOC 强调 | Markdown 预览遵循同一套规则：阅读栏 `760px` 居中（`44px 52px 96px` 留白）、正文字号随用户 `⌘=/⌘-` 平滑缩放（`max(14, fontSize + 1)`，`line-height: 1.72`）、4px 网格、无阴影/渐变；标题为 `foreground` 600 无彩色加光学负字距，仅 `h1` 保留底部 `border` 发丝线（移除 `h2` 分隔横线）；行内代码 `card` 底细框、代码块 `sidebar` 底 `1px border` 圆角框加 `card` 底浮动 `Copy` 胶囊；圆角外框表格去竖向网格线，引用用 `2px` 左条，GFM Alerts 为 `sidebar` 底加 `3px` 左侧强调色卡片；TOC（视口 ≥960px 且 ≥2 个 H1–H3 才显示）沿 `1px` 纵向导轨排列，当前小节以 `foreground` + `2px accent` 左条标记 | `src/markdownPage.ts` `buildPreviewThemeCss` |
| 只有图标的按钮有名字 | 每个只画图标的按钮都通过 `IconButton` 强制要求 `accessibilityLabel`（含 `hitSlop={4}` 与 `focus-visible` 焦点环）：Tab 关闭「Close <文件名>」、标题栏「Toggle sidebar」/「Toggle terminal」、侧栏「Show all files」/「Show changed files」、查找栏「Previous match」/「Next match」/「Close find」、偏好设置「Close preferences」、缩放「Zoom out」/「Zoom in」、终端「New terminal tab」与分栏手柄 `handleAccessibilityLabel` | `src/ui.tsx` `IconButton`、`App.tsx`、`src/Sidebar.tsx`、`src/PreviewPane.tsx`、`src/TerminalPane.tsx` |

**运行时设计 Token 同步（`syncThemeTokens`）与 `nsh.json` 默认值**：`native/src/lib.rs` 将宿主运行时的语义 token 更新能力导出为 `aed/native` `setTokens`，`src/themes.ts` `syncThemeTokens(theme)` 在切换全部 8 套主题时实时同步 `background`、`foreground`、`card`、`popover`、`primary`、`primary-foreground`（`accentForeground`）、`secondary`、`muted`、`muted-foreground`、`accent`、`border`、`input`、`ring` 与 `sidebar` 系列 token，使 `bg-background`、`bg-sidebar`、`bg-primary`、`text-primary-foreground` 等语义类名在任意主题下保持一致高对比度；`nsh.json` 的静态 `theme.cssVars` 与默认主题 `industrial-paper` / `industrial-carbon` 保持一致以保证首帧零闪烁。

### 动效清单（Motion Inventory）

| 触发交互 | 动效机制与曲线 | 辅助功能降级（Reduced Motion） | 代码位置 |
|---|---|---|---|
| 侧栏 / 终端面板收展（`⌘B` / `⌘J` / 顶栏按钮） | `LayoutAnimation.configureNext({ duration: 180, update: { type: "spring", springDamping: 0.88 } })`（轻微欠阻尼弹簧，零回弹过冲） | `if (!reduceMotion())` 守卫开启，开启减弱动态效果时瞬时切换 | `src/workspaceSession.ts` `animatePanelToggle` |
| 模态弹层开关（命令面板 / 偏好设置 / 未保存拦截） | `<Dialog animation="fade">` 短淡入淡出，保持挂载（keep-alive）不销毁内部状态 | 由 `nsh/base` `Dialog` 原生遵循系统减弱动态效果设置 | `src/ui.tsx` `ModalShell` |
| 文件树文件夹展开箭头 | 单个 `<Icon name="chevron-right">` 通过 `rotate-0` ↔ `rotate-90`（`150ms`）原地旋转，不卸载重挂 `<Canvas>` | `motion-reduce:transition-none` 立即切换角度 | `src/Sidebar.tsx` |
| 图表源码复制反馈 | `Copied` 文案维持 `1500ms` 后复位，定时器在卸载或再次点击时清理 | 纯文本状态切换，无位移闪烁 | `src/mermaid.tsx` `createCopyFeedback` |

---

## 关键决定与踩坑记录（Verified Facts & Traps）

1. **`nsh 0.4.0` 桌面无头测试平台参数**：
   - `nsh/test` 的 `open("./App.tsx")` 默认使用 `{ platform: "ios", width: 390, height: 844 }`，会禁用 `fs/promises` 与 `process`。在 `App.test.tsx` 中必须显式传入 `{ platform: "macos", width: 1280, height: 800 }`。
2. **`process.run` / `process.spawn` 必须显式传 `{ cwd }`（`nsh 0.4.0`）**：
   - 未配置宿主 `dataDir` 时省略 `cwd` 会直接抛错；且 `cwd` 必须落在 `nsh.json` 的 `capabilities.fs.write` 授权目录内（`${homeDir}` 或 `/tmp`）。`nsh.json` 中绝不能写 `~` 或 `$HOME`，必须写 `${homeDir}`。
3. **JSX 标签与内置控制流（`nsh 0.4.0`）**：
   - 所有组件标签必须大写开头（`<View>`、`<Text>`）；小写 HTML 标签编译失败。`<If when={...}>` 与 `<Each of={...}>` 是编译器注入的全局宏，**严禁从 `"nsh"` 导入**。
4. **冷启动默认展示 `WelcomePanel` 开屏页，绝不自动进入旧工作区或扫描 `$HOME` / `/`，且支持随时关闭工作区返回开屏页**：
   - 早期版本在未传工作区时回退 `os.homedir()` 或自动恢复 `aed.recentWorkspaces[0]`（如历史遗留的 `data` 目录），导致每次打开 Aed 或等待 LaunchServices `odoc` 事件时总是强制跳进上次的目录页面（`EmptyEditorPanel` + 左侧文件树），无法停留在开屏页。现 `getInitialWorkspaceRoot()` 在无显式工作区（`AED_ROOT`）时返回 `""`：冷启动默认隐藏左侧文件树并渲染双栏包豪斯几何海报开屏页 `WelcomePanel`（`id:welcome-panel`），`Storage` 中的 `aed.recentWorkspaces` 仅在开屏页左栏 `Recent` 台账列表中展示供用户主动点击打开，绝不自动加载为当前工作区。
   - 一旦用户主动打开工作区（`workspaceRoot().length > 0`）且当前无打开的 Tab（`activeFile() === undefined`），编辑区渲染安静的低对比度快捷键提示页 `EmptyEditorPanel`（`id:empty-editor-panel`）；用户可随时通过 `Close Folder`（`⌘⇧W`、菜单栏 `File ▸ Close Folder`、命令面板或空态页 `id:empty-editor-close-folder`）将 `workspaceRoot` 置空并重置工作区状态，随时返回 `WelcomePanel` 开屏页。
   - 左侧文件树顶部目录名（`id:sidebar-workspace-title`）为纯静态标题展示，绝不绑定 `osascript` 选目录弹窗，避免误触文件树顶部时弹出系统模态窗；切换/打开目录仅通过菜单栏、`⌘O`、命令面板或空态页 `id:empty-editor-open-folder` 触发。文件树顶栏只放目录名与 All / Changed 切换，不放打开/关闭文件夹按钮（入口已有 4 处，按钮只增加误触）。
   - 外部点击打开单文件（Finder / Herdr / 终端链接点击或 `AED_OPEN_FILE`）一律以**不带左侧文件树的独立窗口**（`workspaceRoot = ""`）打开：若当前窗口已处于运行态，`finder_bridge.m` 通过 `open -n <Aed.app> --args <path…>` 为这一批文件新开一个不带文件树的独立 Aed 窗口；若为冷启动首次拉起，直接将文件载入当前无文件树窗口，绝不把外部单文件塞进旧工作区目录树里。拖拽到窗口上的文件例外：不论在不在当前工作区内，都在本窗口作为 Tab 打开并保留文件树（见「状态机清单」）。关闭或切换含未保存修改（`dirty`）的 Tab/工作区时弹出确认框（`id:unsaved-changes-dialog`）。状态栏仅在当前工作区确属 Git 仓库（`branch` 非空）时展示分支名，绝不在非 Git 目录伪造 `main`。
5. **`DYLD_INSERT_LIBRARIES` 泄漏坑**：
   - 若不在 `finder_bridge.m` 的构造函数里立即 `unsetenv("DYLD_INSERT_LIBRARIES")`，内置 PTY 终端里启动的所有 macOS 系统命令都会尝试加载 `libFinderBridge.dylib`。
6. **`nsh/base` 无样式原语（`Select` / `Command` / `Tree`）必须传完整浮层与行渲染**：
   - `Select` 原生不带任何背景、边框或字色（默认字色为纯黑 `#000000`）。使用时必须显式传入 `placement`、`popupClass` / `popupStyle` 及 `renderItem`（显式指定主题 `foreground` 字色、字体与选中/高亮态背景），否则在深色主题下会出现「透明底 + 黑字」悬浮现象。
7. **LaunchServices `_LSOpenURLsWithCompletionHandler() failed with error -10825` 兼容性坑**：
   - 在高版本 macOS SDK（如 macOS 27.0）机器上运行 `clang` 编译 `launcher.c`、`finder_bridge.m`、`set_default_handlers.m` 时，若未显式指定 `-mmacosx-version-min=11.0`，生成的 `Contents/MacOS/Aed` 主可执行文件 `LC_BUILD_VERSION` 会写入 `minos = 27.0.0`。低版本 macOS 的 LaunchServices 在执行 `open /Applications/Aed.app` 时检查主二进制 `minos` 与 `Info.plist` `LSMinimumSystemVersion`，直接报错 `-10825`（`kLSIncompatibleSystemVersionErr`）。必须在编译、打包及 `install.sh` 中将 `LSMinimumSystemVersion` 与 `LC_BUILD_VERSION.minos` 统一锁定为 `11.0`。

8. **在 `effect` 的一次运行里 `process.spawn` 的子进程，会在该 `effect` 下次运行时被结束（`nsh 0.4.0` 实测）**：
   - 实测：`TerminalPane` 曾在 `effect(() => { void props.cwd(); ...restart... })` 里直接重启 Shell；先拖入目录（effect 运行，Shell B 在这次运行里启动），再 `⌘⇧W` 关目录（effect 再次运行，B 已被用过，本不该重启），B 却立即退出并打印 `session ended`。`untracked` 不能解除这种归属。
   - 做法：需要在 `effect` 里启动的长寿命进程，用 `setTimeout(..., 0)` 移出这次运行再 `spawn`（`TerminalPane` `followFolder`）。事件回调（按钮、键盘、`onSubmit`）里 `spawn` 不受影响。`App.test.tsx` › a terminal the user has not typed into moves to the folder that opens 锁住此行为。

   - 同理，`TerminalPane` 里所有在 `effect` 中触发的启动或重启（面板显示时启动、偏好设置改 Shell、跟随目录）都用 `setTimeout(..., 0)` 移出 effect 的运行。
9. **Shell 启动期间写入的输入会被丢掉（本机 zsh 配置实测，测试负载下）**：
   - 现象：终端刚打开就提交命令，PTY 回显了这条命令（TTY 已收到），但 zsh 的行编辑器初始化后没有执行它。整套 `nsh test` 下约每 10 次出现 3 次；单独跑不出现，因为负载让 zsh 启动变慢、窗口变大。曾被误判为键盘焦点问题，改用 `app.submit` 后看似变稳，其实没有消除根因。
   - 做法：`createInputGate` 先排队，等 Shell 第一次输出后安静 200 毫秒（提示符画完）再写入，最晚 3 秒强制放行。`App.test.tsx` › terminal input waits until the shell has drawn its prompt 用注入的假调度器锁住规则；› a command submitted the moment the terminal opens still runs 跑真实 Shell。
10. **WebView 页面 JS 与 `injectJavaScript`（`nsh 0.4.0` 实测）**：
   - 无头 `nsh test`（`platform: "macos"`）会挂载 `WebView` 但**不执行页面 JS、不投递 `onMessage`**；页面行为只能在 `--target macos` 真机窗口验证。
   - `webview.hosts` 能力无法放行 `file:` URL：`baseUrl=file:///…` 整页导航报 `ERR_ACCESS_DENIED`，相对/绝对 `file://` 的 `<img>` 同样被拒；`data:` URL 正常。所以本地图片由宿主读取并以 `data:` 内联（`img-src data: https:`）。
   - 把 hljs/markdown-it 源放进行内 `<script>` 会触发 HTML 解析器的 double-escaped 状态吞掉 `</script>`，页面静默不运行；因此壳页 0 个 `<script>`，全部 JS 经 `ref.injectJavaScript()` 在 `onLoad` 后原生注入（绕过 HTML 解析器，且不受 `script-src 'none'` CSP 限制）。
   - `Each` 的 children 参数是 accessor（函数），必须调用 `item()` 取值，直接渲染得到 `[native code]`。
   - `props.file` 为 `Accessor<LoadedFile>`：文件加载期间可瞬时返回 `undefined`，在 `effect`/`onLoad` 里直接读 `.path` 会抛错并使后续重渲染失效——先判空（`MarkdownPreview.sendRender`）。
11. **在 `effect` 里启动的冷启动扫描，其 `git` 子进程会被 `SIGTERM`（`nsh 0.4.0` 无头实测）**：
   - 现象：用 `host.params.workspaceRoot` / `AED_ROOT` 启动时，`Changed` 列表为空、状态栏没有分支名，直到按 `⌘R`。日志显示 `readGitStatus` / `readGitBranch` 的 `process.run` 返回 `{ code: null, signal: "SIGTERM" }`，被吞成空结果。原因同踩坑 8：冷启动 `effect` 读了 `recentWorkspaces`，偏好加载后它再运行一次，结束了第一次运行里启动的子进程。
   - 做法：冷启动扫描用 `setTimeout(..., 0)` 移出 `effect` 的运行。`App.test.tsx` › the diff view follows a save 依赖启动扫描的 Git 状态，锁住此行为。
12. **键盘与焦点（`nsh 0.4.0` 无头实测）**：
   - `nsh/base` 的 `Editor` 自己注册了 `escape` 绑定，原生组件的绑定比 app 的 `keymap.bind` 新，编辑器有焦点时按 Esc 由编辑器处理。所以查找栏的 Esc（`when: "always"`）只在焦点在查找框时生效；`⌘F` 在编辑器有焦点时也能关闭查找栏。
   - 无头测试里 `Input` 的 `autoFocus` 不会把焦点从刚聚焦的 `Editor` 抢走；测试先 `app.type` 进查找框再按 Esc。`Editor` 的 `onFocus` / `onBlur` 会触发，App 据此判断 `⌘F` 是否来自编辑器（不需要改 `TerminalPane`）。
13. **`DataTable` 换数据时列标题不更新（`nsh 0.4.0` 无头实测）**：从 `events.jsonl` 切到 `metrics.csv`，行已是新表的，列标题仍是旧表的 `id / event / ok`（两表列 key 都是 `"0"`、`"1"`、`"2"`）。做法：`PreviewBody` 用 `<Each of={[path]} key>` 按文件重建 `TableBody`，排序信号也放在里面。表头的排序按钮在无头测试里不能按（`text:` 选不到可按的视图），排序不带到下一个表格由同一次重建保证。

14. **退出拦截（`nsh 0.4.0` 实测）**：
   - `nsh/desktop` 与 `nsh` 没有窗口关闭或退出钩子（只有 `Window.close()` 与 `process.exit()`）；macOS 宿主 `nsh-macos-host` 自己实现了 `windowShouldClose:` 与 `applicationShouldTerminate:`，但不交给 JS。所以关闭按钮与系统退出只能由 `finder_bridge.m` 拦截。
   - `keymap.bind({ "mod+q": … })` 直接抛错：`"mod+q" cannot be bound: it quits the app`。`⌘Q` 只能挂在菜单项上。
   - 无头 `nsh test` 没有菜单栏，`app.keyboard.press("mod+q")` 碰不到菜单项；测试经命令面板触发同一个动作。无头下获准的 `process.exit()` 会结束被测 App，之后的步骤以 `the app left` 失败，可以用来断言「已退出」。

15. **测试文件自己不能起进程；`app.texts()` 读不到排在屏幕外的文字（`nsh 0.4.0` 实测）**：
   - `*.test.tsx` 顶层调用 `process.spawn` 抛 `process is available on desktop hosts`；所以真实 Shell 的测试都经 `open("./App.tsx", { platform: "macos", ... })` 打开的 App 自己的终端跑（`App.test.tsx` › a resize reaches the shell as its terminal size 等 5 项）。
   - 测试镜像曾把全部行排成会换行的 `Text`：一行 3000 个汉字换成几十行后，后面的行排到面板外，`app.texts()` 就看不到它们，`waitUntil` 超时。改为只显示最新 14 行、每行 `line-clamp-1`。
   - `keymap.bind` 的说明（`.nsh/types/nsh/index.d.ts`）：同一按键有多个绑定时只跑最新的。终端借此在有焦点期间接管 ⌘K/⌘F。
16. **NSH 混合模板与原生组件（`nsh 0.4.0` 实测）**：
   - `nsh.json` 加 `"rust": "native"` 后，`nsh check` 会编译 crate 并生成 `.nsh/types/aed/native.d.ts`；首次约 68 秒，之后增量 1 秒内。`nsh test` 同时跑 crate 的 `cargo test`。
   - `nativeComponent` 的事件名不能和 `View` 自带的事件撞名：事件叫 `focus` 时 handler 是 `onFocus`，与内置的 `onFocus: () => void` 交叉成无参类型，`nsh check` 报 TS2322。所以视图的焦点事件叫 `focused`（`onFocused`）。
   - 原生视图里的键直接进 Rust，TSX 看不到；TSX 判断「用过」读 `TerminalSession.used`。测试通道的输入可能还在闸门里排队、没到 Rust，所以 Tab 另记 `typed`，否则排队期间换目录会重启 Shell（`App.test.tsx` › a half-typed terminal command stays, with its shell, when a folder opens）。
   - Shell 结束靠 PTY 读到 EOF 判定（读线程随后 `waitpid`）。macOS 上会话首进程退出时内核收回这个 TTY，留在后台的 `sleep 20 &`、`nohup … &` 也拦不住 EOF（`native/src/session/tests.rs` › a_shell_that_exits_ends_even_while_a_job_holds_the_terminal 实测 0.01 秒内收到 exit），所以不另起 `waitpid` 线程。
   - macOS 14 起 `NSView.clipsToBounds` 默认 NO，`drawRect:` 的脏区可以超出视图边界；终端视图按脏区铺背景，曾把上方的终端顶栏（Tab、Shell 下拉）和与编辑区的分界一起盖掉。所以 `aed.terminal` 视图创建时 `setClipsToBounds(true)`。无头测试看不到，靠真机核对。
   - `CTFontDrawGlyphs` 会套用上下文的文本矩阵（text matrix），而文本矩阵不属于图形状态，`drawRect:` 之间不重置。AppKit 自己画字、或我们对本字体没有的字（`➜`、`✗`、中文）用 `NSAttributedString` 回退绘制之后，矩阵会留下位移，同一次重绘里后面的行和字就整体右移：表现为输出行前多一个空格、提示符后空隙变大，以及键入的 `echo` 跟旁边的字叠成 `echh`。所以 `flush` 每次画字形前把文本矩阵设回单位矩阵（`grid::tests` › text_starts_in_its_cell_whatever_drew_text_before，用位图上下文复现）。
   - Rust 程序启动时把 SIGPIPE 设成忽略，`forkpty` 的子进程会原样继承；`std::process::Command` 会替子进程复位，`forkpty` 不会，所以 `pty::exec_shell` 自己复位（› the_shell_gets_default_signals_and_a_utf8_tty）。
17. **`nsh/base` `Editor` 关闭内置 Allsum 高亮、装饰器无闪刷新与行号垂直对齐（`nsh 0.4.0` 实测）**：
   - `<Editor>` 默认 `highlighting={true}` 会同时运行 `nsh-base` 硬编码的 Allsum 配色（`#c4a7ff`、`#6fd3d8`），与 `decorations` 未覆盖的词交错撞色；必须传 `highlighting={false}` 完全交由 Aed 自己的主题装饰器着色。
   - 动态模板类名 `text-[#rrggbb]` 不会被编译期 Tailwind 扫描收录，必须在 `EditorDecoration.style` 上下发内联 `{ color, fontStyle }` 才能真实渲染 8 套主题精确语法色；且 `nsh-base` 的 `RowContent` 派生 `PartialEq` 仅比较 `decorations: Vec<usize>` 下标数组，同文件同步回退升级为异步 TextMate 或切换主题时，通过 `stampDecorations` 奇偶交替前置 1 个零宽空装饰（`0:0..0:0`）使下标整体偏移 `+1`，即可在单帧内无闪烁刷新全部行内颜色并完整保留撤销栈与光标。
   - `nsh-base` 的 `EditorPart::Gutter` 内部行容器已自动附加 `mt(rows_top)`（等于 `content.paddingTop`）；因此顶部留白只设在 `styles.content.paddingTop`（`12pt`），`styles.gutter` 不再重复设置 `paddingTop`，确保行号 `1` 与正文第 `1` 行像素级水平对齐。

---

## 试过不做的方案（Tried & Rejected）

- **xterm.js WebView + `python3` `pty.fork()` 帧协议桥（I-019 到终端改原生之间）**：能用，但每个键要经过页面 JS → `postMessage` → TSX → base64 帧 → Python 进程 → PTY，输出再原路返回，打字有可感的延迟；还要维护 380 KB 的 vendored 运行时、页面协议与回放缓冲。改为 libghostty-vt + 原生视图，键在 Rust 里直接写 PTY。代价是混合模板：首次 `nsh check` 编译 crate 约 68 秒（早先「混合模板太慢」的判断按此改写，增量构建在 1 秒内），并多一个要下载校验的 27 MB 静态库。
- **使用 `qlmanage` + 底部外部打开操作栏预览 PDF**：`qlmanage -t` 在部分系统环境下会弹窗或阻塞，且底部常驻 `Open in Preview` 操作栏喧宾夺主；已改为直接调用 macOS 内置 `sips -Z 1800 -s format png` 生成 2x Retina 预览图，并以暖白纸张底衬（`#f7f4ee`）+ 缩放控制条承载，避免透明底黑字在深色主题下不可读。
- **在底部 24pt 状态栏放置刷新图标与主题/字体切换按钮**：在非 Git 目录下左下角会留下孤立无文字的 `↻` 图标（语义不明），而右下角的主题下拉、字体下拉与单点循环切主题按钮紧贴终端输入行与窗口缩放边缘，极易误触切走配色或弹出大菜单；现 `StatusBar` 统一改为纯只读状态展示，主题/字体配置与工作区刷新统一走 `⌘,`（Preferences）、应用菜单与 `⌘⇧P` 命令面板。
- **在 Markdown 预览中用字符画（`mmd2txt`）或双 WebView 离屏 PNG 光栅化渲染 Mermaid**：字符画不满足桌面编辑器矢量缩放需求；而额外挂载第 2 个离屏 `1280×900` `WebView` 把 SVG 光栅化为 2x PNG 会多占一个 WebKit 进程、放大后模糊且长图易被 `<canvas>` 裁切。现已统一复用 `MarkdownPreview` 的单个沙箱 `WebView` 直接渲染原生矢量 SVG 并支持 `50%–250%` 无损缩放。
- **原生 `TextView` 重新排版做 Markdown 预览**：需从零实现阅读排版、语法高亮、TOC、链接路由与图片加载，工作量与成熟库差距大；改用 WebView + markdown-it 生态。
- **在宿主 QuickJS 上渲染 Markdown 再下发 HTML**：实测同一 60 KB 合成文档 QuickJS 中位 283 ms vs WebView JSC 52 ms（快 ~5.5×），且 608 KB 运行时的解析/求值占住应用线程；渲染改在页面侧完成，宿主只做载荷与文件/URL 服务。
- **直接复用 xicilion markdown-viewer 的成品 bundle**：该扩展为 GPLv3，不能随 Aed 分发。Aed 只沿用旧逻辑：运行时用 `loadMermaidBundleJs()` 读取用户本机已装扩展里的 Mermaid bundle，自己不打包它。
- **单行 `<Input>` 加整行写入的终端（I-019 之前）**：按 Enter 才把整行写进 PTY，没有 Ctrl-C / Tab / 方向键，宿主只认几种 CSI，`vim` / `less` / `top` 不能用，尺寸写死 32×140，sudo 密码明文可见。
- **第三方 Rust ghostty 绑定 crate**：版本与 libghostty-vt 1.0.1 的 C API 对不上且多一层依赖；用 bindgen 从官方头文件生成 `native/src/ffi.rs`，只链官方静态库。
- **WebView `baseUrl=file://` 加载相对资源**：`nsh 0.4.0` 能力层无法授予 `file:`（见踩坑记录 #10）；改为 CSP `img-src data: https:` + 宿主侧图片内联，KaTeX 字体也全部 `data:` 内联。

---

## 验证与基准（Verification & Benchmarks）

| 检查项 | 命令 | 基准指标（macOS arm64） |
|---|---|---|
| 静态检查与构建 | `oxlint && nsh check && nsh build` | `oxlint` 0 warnings/errors（~30ms）；编译 `native/` crate 加 TS 检查增量 <0.5s（首次约 68s），字节码构建 ~60ms |
| 分层单测与原语契约 | `nsh test src/<module>.test.ts(x)` | `target`、`classify`、`themes`、`session`、`tabs`、`workspace`、`ui`、`mermaid`、`markdownPage`、`PreviewPane` 等纯逻辑与无头原语单测，单套件热缓存 ~2s |
| 代码复杂度与重复度 | `ub crapper --no-coverage && ub dryer` | 全仓 TS/TSX 函数圈复杂度 `CC ≤ 9`（`App.tsx` 258 行），`dryer` 0 处重复候选 |
| 原生桥接与脚本契约 | `sh scripts/test-native-bridge.sh` | `shellcheck` + `launcher.c` / `finder_bridge.m` 编译与隔离缓存目录实测（`file://#L` 编码、`foo:10:20` 无歧义剥离、符号链接安全、`home`/`loose` 窗口复用），约 2s |
| 单测与桌面无头 E2E | `nsh test App.test.tsx` / `nsh test --trace` | `App.test.tsx` 86 项热缓存 ~37.0s（含跨 Tab `⌘Z` 撤销隔离、冲突转缺失单横幅、`[Diff]` 胶囊持久与实时对比、`FindBar` `1/N` 跳转），加 `src/*.test.*` 与 Rust `cargo test` |
| libghostty-vt 固定版本 | `sh scripts/fetch-ghostty-vt.sh` | 1.0.1 zip 与 `libghostty-vt.a`（macos-arm64_x86_64）SHA-256 都对上才拷入；已有且哈希对时不下载 |
| 桌面真机窗口测试 | `nsh test App.tsx --target macos` | AppKit 真机窗口逐步交互验证 |
| 仅构建与签名校验 | `sh scripts/package-macos.sh --build-only --skip-tests` | 产出 `.nsh/out/Aed.app`、注入原生桥接、归一化 `minos=11.0` 并通过 `codesign --verify --deep --strict`，不写 `/Applications` |
