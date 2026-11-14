---
title: Aed 架构与模块契约
description: 基于 Native Shell (nsh 0.3.0) 的 macOS 原生多格式预览器、代码编辑器与内置 PTY 终端（Aed — Another Editor）架构、持久化契约与实测踩坑记录。
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

- `webview.hosts` 只管 WebView 的 `src` 与顶层跳转。`"webview": { "hosts": [] }` 仍允许 `html` 内联页面与 `about:blank`，所以 Markdown 预览与 Mermaid 离屏渲染器都不受影响（终端不用 WebView）；去掉整个 `webview` 键才会让 `html` 也被拒。页面自己的子资源（脚本、图片、XHR）不归它管，由各页面的 CSP 管。
- `network.hosts` 管 `fetch`、WebSocket、远程图片与视频源。`<Image>` 的 `blob:` URL 在进核心前已换成 `data:` 源（trace 里是 `data:image/png;nsh-key=…`），`<Video src={绝对路径}>` 不含 `://`，两者都按「app 自己的文件」放行（`allows_media`）。App 里没有 `fetch` / `WebSocket` / `net`。
- 需要联网的新功能（例如远程图片预览）要在这里写明原因，再把具体主机加进 `network.hosts`，不要再写 `*`。

### 持久化标识与 IPC 契约（不可随意改名）

| 类别 | 标识符 / 路径 | 用途与新旧兼容约定 |
|---|---|---|
| Bundle ID | `dev.byronwayne.aed` | `nsh.json` 与 `scripts/set_default_handlers.m` 共用；改名会导致 LaunchServices 默认打开关联失效 |
| `Storage` 键 | `aed.fontFamily` | 用户字体名；未设置时依次回退旧键 `native-editor.fontFamily`、Ghostty 配置或 `JetBrainsMono Nerd Font Mono` |
| `Storage` 键 | `aed.fontSize` | 字号（`9`–`28` 整数字符串）；未设置时回退旧键 `native-editor.fontSize`，非法值回退 Ghostty 字号或 `13` |
| `Storage` 键 | `aed.theme` | 主题 ID（8 套内置主题，默认 `industrial-paper`）；未设置时回退旧键 `native-editor.theme`，未知 ID 回退默认主题 |
| `Storage` 键 | `aed.shell` | 默认 Shell 绝对路径（如 `/bin/zsh`）；未设置时回退旧键 `native-editor.shell` |
| `Storage` 键 | `aed.recentWorkspaces` | JSON 字符串数组（最多保留最近 5 个显式打开的非 `/` 工作区目录，单独打开外部文件不写入）；未设置时回退旧键 `native-editor.recentWorkspaces`，解析失败回退 `[]`。App 启动时先读入已存列表，之后的记录（`AED_ROOT` 启动目录、切换目录）都排在读取之后（`rememberWorkspace`），不会用空列表覆盖它（I-017） |
| 环境变量 / Host 参数 | `AED_ROOT` / `NATIVE_EDITOR_ROOT` / `host.params.workspaceRoot` | 启动时初始工作区目录；均未设置时返回 `""`（直接展示 `WelcomePanel` 开屏页并列出 `Recent` 历史工作区供点击打开，绝不自动进入旧工作区或扫 `$HOME`、`/`） |
| 环境变量 / Host 参数 | `AED_OPEN_FILE` / `NATIVE_EDITOR_OPEN_FILE` / `host.params.openFile` | 启动时直接以无文件树（`workspaceRoot = ""`）独立窗口打开的第一个文件。值可以带 `:line(:col)` 后缀（`launcher` 解析出行列时附上），由 `resolveExternalFileReference()` 先按原样找文件，找不到才剥后缀并跳到该行（不写入历史工作区）。`launcher` 启动时先清掉继承来的 `AED_OPEN_FILE` / `AED_ROOT` / `AED_OPEN_QUEUE` / `NATIVE_EDITOR_*`，只按本次参数重新设置（Aed 内置终端里的 Shell 和 `finder_bridge.m` 的 `open -n` 都会继承当前窗口的值） |
| 窗口标题标记（JS → 原生） | 标题以 ` — Edited` 结尾（`src/session.ts` `EDITED_TITLE_SUFFIX` / `windowTitle`，即 `Aed — Edited`） | JS 告诉 `finder_bridge.m`「有未保存修改」的唯一通道：有脏 Tab 时 App 把窗口标题设为 `Aed — Edited`，否则 `Aed`；用户同意退出后立即去掉标记，下一轮事件循环再 `process.exit`（`src/session.ts` `runApprovedQuit`，让新标题先生效）；`process.exit` 抛错，或 `QUIT_SETTLE_MS`（2 秒）后进程仍在（宿主取消了退出），标记按脏 Tab 恢复，保护重新生效。原生 → JS 不另设通道：原生选中 App 自己的 ⌘Q 菜单项（`Quit Aed`，`keyEquivalent` 为 `q` + Command 且 action 不是 `terminate:`）。两边的字面量必须一致（`App.test.tsx` › the window title carries the edited mark scripts/finder_bridge.m reads）。旧版 dylib 不读标题、新版 dylib 遇到不带标记的旧 JS 都按宿主原行为退出，没有兼容负担 |
| 环境变量 / Host 参数 | `AED_OPEN_QUEUE` / `host.params.openQueue` | 本进程的 Finder 队列目录，`launcher` 在 `execv` 前设置，`libFinderBridge.dylib` 构造函数按 `getpid()` 重算并覆盖（不信任传入值）；`nsh.json` `process.env` 白名单需含此名。App 只接受形如 `<缓存目录>/open-<数字>` 的值（`resolveFinderQueueDir`，两边先 `path.normalize`：原生按 `$HOME` 原样拼接，`/Users/x/` 会得到 `//Library`），否则不读队列。`host.params.openQueue` 只供测试注入 |
| 每用户缓存目录 | `~/Library/Caches/dev.byronwayne.aed/`（`0700`） | Aed 自己的临时文件都放这里（`aedCacheDir()` / `scripts/aed_paths.h`）。原生代码用 `O_NOFOLLOW\|O_DIRECTORY` 打开后 `fstat` 校验：必须是真目录（不是符号链接）、属于当前用户，权限不是 `0700` 就改成 `0700`，否则放弃写入。App 侧 `fs/promises` 没有 `mode` / `chmod`，只在其下 `mkdir` 出 `ql/`，靠 `~/Library` 本身是 `0700`。WebKit 也把 Aed 的网页缓存放在同一目录的 `WebKit/` 下，两者互不干扰 |
| Finder 队列 | `<缓存目录>/open-<pid>/<seq>.path` | 每个 Aed 进程一个目录，每个待打开路径一个文件（原样路径字节，无换行）。写入方先用 `O_CREAT\|O_EXCL\|O_NOFOLLOW`、`0600` 建 `.<seq>.tmp`，写完再 `renameatx_np(RENAME_EXCL)` 成 `<seq>.path`，所以读方看不到半截文件。写入方：`launcher`（命令行第 2 个起的文件）、`finder_bridge.m`（冷启动阶段收到的 AppleEvent，一批文件全部写入）。读方：`consumeFinderOpenQueue()` 只认 `<数字>.path`，按数字（不是字典序）排序，逐个 `lstat`：普通文件读出内容，其它（符号链接等）不读，两者都删除（`unlink` 只删链接本身）；`.<seq>.tmp` 不碰。`launcher` 启动时清空本 pid 的旧目录，并删除进程已不存在的 `open-<pid>` 目录（是符号链接时只删链接） |
| QuickLook 临时图 | `<缓存目录>/ql/<随机 UUID>.png` | `generateQuickLookUrl()` 让 `sips` 把 PDF 首页写成 PNG，读进内存转成 `blob:` URL 后立即删除 PNG（`sips` 失败也删）。内存里每个文件只留最新版本（`mtimeMs:size`）的 URL，新版本生成后 `revokeObjectURL` 旧的 |
| 终端调试日志 | `<缓存目录>/terminal.log`（`0600`，超过 2 MB 改名为 `terminal.log.1` 后重开） | `native/src/log.rs`。只在 App 里写：`aed.terminal` 组件注册时才 `log::enable()`，无头 `nsh test` 与 `cargo test` 不注册组件，不会产生这个文件。逐行记录本地时间加：按键（keyCode、字符、修饰键、是否有输入法组字）、输入法 insert/mark/unmark、发给 Shell 的字节（控制字符转义）、Shell 输出前 240 字节、按键后 1.5 秒内光标所在行的格子内容、布局（视图尺寸、字体、格子尺寸、行列数）、焦点、链接、Shell 启动与退出。程序读密码时（PTY `ECHO` 关且 `ICANON` 开，即 `getpass` / `sudo` 的读法）只记字节数，不记内容。zsh/readline 在提示符下也关 `ECHO`，但它们关了 `ICANON`，不算读密码（`session::tests` › only_a_password_read_keeps_keys_out_of_the_log）。目录由 `DirBuilder` 以 `0700` 创建，文件用 `O_NOFOLLOW` 打开，跟 App 侧一样不另做 `fstat` 校验，靠 `~/Library` 本身是 `0700`。新增文件，没有旧版本要兼容 |
| 测试 Shell 的私有目录 | `$TMPDIR/aed-shell-<pid>/`（`0700`，`std::env::temp_dir()`，macOS 上是每用户的 `/var/folders/…/T/`） | `native/src/pty.rs` `private_config`。只有 App 注册原生视图时调用 `pty::use_user_config()`，此后 Shell 用用户自己的启动文件和历史；之前（无头 `nsh test`、`cargo test`）每个 Shell 的 `ZDOTDIR` 和 `HISTFILE`（`<目录>/.history`）都指向这里，替换继承来的同名变量。macOS `/etc/zshrc` 无条件设 `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`，所以只设 `HISTFILE` 拦不住 zsh，要靠 `ZDOTDIR`；bash 认继承的 `HISTFILE`。效果：测试不再写用户的 `~/.zsh_history` / `~/.bash_history`（曾写入 4836 行），也不再加载用户的 `~/.zshrc`（oh-my-zsh 自动建议曾把测试命令当补全显示）。目录不删，留在系统临时目录里由系统清理。新增，无兼容问题（`session::tests` › a_shell_outside_the_app_keeps_its_history_out_of_home、`App.test.tsx` › test shells keep their history out of the user's home） |
| Mermaid bundle | 无磁盘缓存 | `loadMermaidBundleJs()` 每个进程直接从 VS Code / Cursor / Antigravity 扩展目录提取一次，结果只缓存在内存（没找到不缓存，下次渲染器启动再找） |
| Rust crate / 原生模块 | `nsh.json` `"rust": "native"`；模块 `aed/native`（`TerminalSession` 类）；原生组件 `aed.terminal`（props `session` / `fontFamily` / `fontSize` / `theme`，事件 `focused` / `link`，命令 `focus`） | TSX 与 `native/src/lib.rs` 两边的字面量必须一致。原生组件只在 macOS 宿主注册，无头 `nsh test` 里是一个空视图。终端改原生时新增，没有旧缓存或配置要兼容 |
| 宿主事件（仅测试） | `aed.terminal.test` | `TerminalPane` 的测试通道，替代原生视图对当前 Tab 做的事（无头测试没有原生视图）：`{type:"input", data, binary?}`（当作键入，经启动闸门）、`{type:"resize", rows, cols}`、`{type:"focus", focused}`；第一次收到时打开纯文本镜像 `id:terminal-mirror`（最新 14 行）。打包宿主不发送；与 `aed.preview.eval` 同级。原名 `aed.terminal.page`（xterm 页面消息），只有测试用，改名无兼容问题 |

**旧 `/tmp` 路径（I-018 起废弃）**：`/tmp/aed-open.queue`、`/tmp/aed-ql/`、`/tmp/aed-mermaid/` 不再读也不再写。`/tmp` 所有人可写，其他本机用户可以预先放好符号链接或伪造内容，所以 Aed 也不去删除它们（删除本身会跟随别人放的链接）。升级后旧文件留在原处，用户可以手动 `rm`。新旧版本同时运行时互不影响：旧版本仍读写 `/tmp`，新版本只用每用户缓存目录。

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
|                    | ➜ ~ echo NSH_PTY_OK_2026                                     |    native aed.terminal view, libghostty-vt per Tab
|                    | NSH_PTY_OK_2026                                              |
|                    | ➜ ~ █                                                        |
+--------------------+--------------------------------------------------------------+
| ⎇ master*          |                             README.md · 2.1 KB · Ln 1, Col 1 · markdown | <- StatusBar (24pt, read-only)
+--------------------+--------------------------------------------------------------+
```

### 模块职责表

| 文件 | 核心导出 | 职责边界 |
|---|---|---|
| `App.tsx` | `App` (mount root) | 顶层信号状态、可拖拽分栏（水平 `Sidebar` + 垂直 `PreviewPane`/`TerminalPane`）、快捷键、Finder 队列轮询、Preferences 弹窗 |
| `src/session.ts` | `WINDOW_TRANSITIONS`, `deriveWindowMode`, `deriveEditorSurface`, `planWorkspaceIntent`, `externalOpenKeepsTree`, `decideGuard`, `unsavedQuestion`, `nextActiveAfterClose`, `canToggleSidebar`, `serialize` | 窗口会话状态机的纯规则（无 I/O）：窗口模式、编辑区显示内容、工作区打开/关闭计划、外部文件是否保留文件树、未保存确认框（含按动作区分的问句）与关 Tab 后的激活项；`serialize` 让一个异步任务的运行不重叠（磁盘比对用它）。见「状态机清单」 |
| `src/saving.ts` | `saveInStore`, `settleSavedCopy`, `describeFailure` | 一个 Tab 的保存规则，store 与写盘函数由 App 传入（可无 I/O 测试）：只存脏且可保存的副本、写入期间的输入不丢、关掉的 Tab 不写回、失败记在副本上不抛错。见「状态机清单」#4 |
| `src/classify.ts` | `classifyFile`, `parseTableData`, `formatHexDump`, `probeImageDimensions`, `normalizeMachOBuildVersion`, `generateQuickLookUrl`, `createBlobUrl` | 纯文件类型判定（扩展名 + 前 4 KB `\0` 探测）、CSV/TSV/JSONL 解析、4 KB 十六进制格式化、PNG/GIF/SVG 尺寸探测、Mach-O `LC_BUILD_VERSION` 最低系统版本归一化、PDF `sips` 缩略图生成 |
| `src/workspace.ts` | `getInitialWorkspaceRoot`, `getInitialOpenFile`, `aedCacheDir`, `resolveFinderQueueDir`, `consumeFinderOpenQueue`, `externalFileCandidates`, `resolveExternalFileReference`, `normalizeExternalFilePath`, `scanWorkspace`, `loadFile`, `getPreloadedFile`, `warmWorkspaceFiles`, `readDiskStamp`, `isBehindDisk`, `hasChangedOnDisk`, `reloadFromDisk`, `reloadIfChangedOnDisk`, `saveFileText`, `getFileDiffPatch`, `pickWorkspaceFolder`, `isDirectoryPath` | 工作区并发文件树与 Git 状态扫描、小文件后台预热缓存（`≤ 256 KB`）、外部文件引用解析（先按原样找文件，找不到才剥 `:line:col` / `#L` 并带上行列；`file://[localhost]` 百分号解码）、目录与普通文件区分、文件按需加载（音视频只 `stat` 不全量读入内存）、保存回写、`osascript` 选目录 |
| `src/PreviewPane.tsx` | `PreviewPane`, `formatMediaMeta`, `withPreviewCsp` | 各 `FileKind` 的视图切换（`preview` / `source` / `diff`）、外部打开带行列时移动光标（`reveal`）、`.html` 预览加 CSP 并关闭页面 JS、代码编辑器内联查找（`Cmd+F`）、表格排序、图片缩放（`25%`–`400%`）与棋盘格背景切换 |
| `src/mermaid.tsx` | `MermaidRendererHost`, `MermaidDiagramBlock`, `detectMermaidKind`, `preprocessMermaidCode`, `requestMermaidRender`, `loadMermaidBundleJs`, `buildMermaidConfig`, `rememberRender` | 按需延迟初始化的隐藏离屏 `WebView`（1280×900）运行 Mermaid 布局、将 `<foreignObject>` 内联为原生 SVG `<text>` 并光栅化为 2x Retina PNG `blob:` URL；`buildMermaidConfig` 是两条 Mermaid 渲染路径共用的主题配置工厂 |
| `src/markdownPage.ts` | `buildPreviewShellHtml`, `buildPreviewThemeCss`, `classifyPreviewLink`, `resolvePreviewImagePath`, `imageMimeForPath`, `parsePreviewMessage`, `handlePreviewMessage`, `isExternalOrHashUrl`, `resolveRelativeLink` | Markdown 预览的纯协议/路径/主题逻辑（无 I/O）：严格 CSP 壳页、主题化阅读排版与 TOC CSS、链接与图片路径安全分类、页面上行消息校验与路由 |
| `src/MarkdownPreview.tsx` | `MarkdownPreview` | Markdown WebView 的 I/O 外壳：注入运行时与 `render`/`setTheme`/`setImages` 载荷、图片按 `classify` MIME 读为 `data:`（≤20 MB）、`openUrl`/已解析路径回传、进程内滚动记忆、测试调试通道 |
| `vendor/markdown/` | `entry.mjs`, `page.mjs`, `build.mjs`, `package.json`, `bun.lock`, `THIRD_PARTY_NOTICES.txt` | 固定版本的第三方运行时源码（markdown-it 插件组 + KaTeX + hljs + github-markdown-css + DOMPurify），仅由 `scripts/build-markdown-vendor.sh` 构建为 `src/markdownVendor.generated.ts` |
| `src/Sidebar.tsx` | `Sidebar`, `CommandPalette` | 左侧 `All` / `Changed` 文件树、Git 状态徽章（`M`/`A`/`U`/`D`/`R`）、`Cmd+P` 文件快搜与 `Cmd+Shift+P` 命令面板 |
| `src/TerminalPane.tsx` | `TerminalPane`, `discoverTerminalEnvironment`, `parseGhosttyConfig`, `createInputGate`, `shouldFollowCwd`, `linkTarget` | 终端的 Tab 编排：每个 Tab 一个 `TerminalSession`，事件循环（`nextEvent`）、Shell 启动/重启/跟随目录与切换规则、⌘-点击链接的打开、焦点期间的 ⌘K/⌘F 绑定、测试通道 `aed.terminal.test`、本机 Shell 与 Ghostty 配置探测 |
| `src/terminalTheme.ts` | `buildTerminalTheme`, `ANSI_PALETTES`, `ANSI_NAMES` | 主题到终端颜色（背景、前景、光标、选区、16 色 ANSI）的纯映射，交给原生视图的 `theme` prop |
| `native/` | `TerminalSession`（`src/session.rs`）、`aed.terminal` 视图（`src/view.rs`）、`src/grid.rs`、`src/keys.rs`、`src/pty.rs`、`src/ffi.rs` | Rust crate：libghostty-vt 终端与 PTY 会话、AppKit 视图的绘制与输入（键盘/IME/鼠标/滚轮/剪贴板）、按键表、`forkpty`；`ffi.rs` 是 bindgen 从 libghostty-vt 头文件生成的绑定（命令见 `scripts/fetch-ghostty-vt.sh`） |
| `vendor/ghostty-vt/` | `libghostty-vt.a`, `Headers/` | 不入库（27 MB）：`scripts/fetch-ghostty-vt.sh` 下载官方 1.0.1 xcframework，校验 zip 与静态库的 SHA-256 后拷入；`native/build.rs` 静态链接它 |
| `src/themes.ts` | `EDITOR_THEMES`, `getThemeById`, `computeSyntaxDecorations`, `buildEditorThemeStyles` | 8 套配色主题（默认 Industrial Paper / Industrial Carbon，另有 Kanagawa Dragon、Tokyo Night、Catppuccin Mocha、One Dark、Rose Pine、GitHub Light）及带 LRU 缓存的预编译正则语法高亮装饰器 |
| `src/icons.tsx` | `Icon`, `FileBadge`, `AppLogo` | 内联矢量图标与按文件扩展名着色的类型徽章 |

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

转移表是 `WINDOW_TRANSITIONS`（`Record<模式, Record<事件, 模式>>`）。加模式或事件不补表，`nsh check` 报错；`App.test.tsx` › every WINDOW_TRANSITIONS cell matches the rules App.tsx runs 用 App 调用的同一组函数重放每一格。规则：

- **重新打开当前目录**（`⌘O` 选同一目录、`Open Recent` 当前项、拖入当前目录）只刷新，保留 Tab（`planWorkspaceIntent` → `refresh`）。
- **拖入文件**（`drop-file`）表示「在这里打开」：不论文件在不在当前工作区内，都作为 Tab 打开，模式不变（有工作区则保留文件树）。**外部点击**（`click-file`：Finder / Herdr / `AED_OPEN_FILE`）一律进 `loose`，保持 I-007 规则。两者由 `externalOpenKeepsTree(origin)` 区分。
- **未保存确认框**只有两态：空闲、确认中。确认中时，新的受保护操作（关 Tab、`⌘⇧W`、切换工作区）直接丢弃（`decideGuard` → `busy`），不能替换用户正在回答的那个请求。问句按动作区分（`UnsavedGuard.action` → `unsavedQuestion`）：关 Tab「before closing?」、关文件夹「before closing the folder?」、切换文件夹「before opening another folder?」、退出「before quitting?」。选 `Save` 时任一文件保存失败：关掉确认框、不执行动作，切到那个 Tab，由它的保存失败横幅说明原因。
- **退出**（I-016）：`⌘Q` 是 App 自己的菜单项 `Quit Aed`（不再用 `role: "quit"`），命令面板 `File: Quit Aed` 走同一个 `actions.quit()`（`createQuit`）：有脏 Tab 先过未保存确认框，放行后 `process.exit(0)`。窗口红色关闭按钮与系统退出（Dock、注销、`osascript quit`）由 `finder_bridge.m` 在标题带 ` — Edited` 时转成选中 `Quit Aed`（见「Finder 桥接与打包流水线」）。用户放行后标记立即去掉，之后再来的退出请求（宿主自己的 terminate 路径）不再询问。
- 关 Tab 后激活剩下的最后一个 Tab，文件树选中项同步（`nextActiveAfterClose`），所以再点同一文件能重新打开。

### 其它状态机

| # | 状态机 | 状态 | 位置 | 现状 |
|---|---|---|---|---|
| 2 | 编辑区显示 | `file` / `welcome` / `workspace-empty` | `deriveEditorSurface` | 显式 |
| 3 | 文件与磁盘一致性 | 新鲜 / 过期 / 冲突 / 已移走 | 每份副本自带：`LoadedFile.diskStamp`（读到的字节的 `mtimeMs:size`）与 `LoadedFile.diskChanged`（冲突）；App `checkTabAgainstDisk`、`createActiveTabDiskCheck` | 显式。戳跟着副本走，不存在按路径共享的表：被保留的脏副本带着自己的旧戳，下一次比对仍判为过期，冲突不会丢。`loadFile` 先读戳再读字节（中途被写只会多判一次过期，不会漏判）；保存时换成新戳。当前 Tab 每 1.5 秒（`DISK_CHECK_MS`，一次 `stat`）比对一次，**切到某个 Tab 时立即比对**；比对从不重叠（`serialize`：进行中再被调用则结束后补跑一次，那次比对抛错也照样补跑）。干净 Tab 过期则直接重读。脏 Tab 过期则把该副本标为 `diskChanged`，编辑区上方出现 `id:disk-conflict-banner`：`Reload from Disk` 丢弃编辑并重读；`Keep My Edits` 保留编辑并把磁盘当前戳记为该副本的戳，下次保存会覆盖磁盘，之后磁盘再变会再问。冲突随副本结束：保存、关 Tab、切目录、重读都换掉副本，所以横幅不会在下一次比对前「复现」。每个 Tab 各有各的冲突。源文件消失（`stat` 失败而副本有戳，`markMissingInMap`）记为 `LoadedFile.diskMissing`，不当成「没变」：编辑区上方 `id:file-missing-banner`「<name> was moved or deleted.」，`Close` 关 Tab（脏则先问），`Save As…`（`osascript` `choose file name`）把 Tab 迁到新路径并写入全文；`saveFileText` 在原路径已不存在时抛 `the file was moved or deleted`，所以 `⌘S` 只显示保存失败横幅，不会在旧路径重建文件 |
| 4 | 单个 Tab | 加载中 → 干净 ⇄ 脏 → 关闭；保存：空闲 → 写入中 → 已保存 / 失败（`saveError`）；只读（`readOnly`）；模式 `preview` / `source` / `diff` | `LoadedFile.dirty` / `.mode` / `.saveError` / `.readOnly`，`loadedFiles`；保存规则 `src/saving.ts` `saveInStore` | 半显式。关 Tab 时从 `loadedFiles` 删除；从 `All` 再打开时退出 `diff`。**保存**只在 `dirty` 且 `canSaveFile`（非不透明类型、非只读）时写盘，`⌘S`、菜单、命令面板与确认框走同一条路。写完后按当时 store 里的副本收尾（`settleSavedCopy`）：写入期间又输入的保留最新文本并保持 `dirty`，模式保留；期间关掉的 Tab 不写回。写盘失败把「`Could not save <path>: <原因>`」记在副本上，编辑区上方出现 `id:save-error-banner`（`Dismiss` 关掉），Tab 保持 `dirty`，下次保存成功时清除；`saveInStore` 从不抛错。**打开失败**（文件不存在、读不了；文件树、`⌘P`、Markdown 链接、拖入、Finder 点击都一样）在编辑区上方显示 `id:open-error-banner`「`Could not open <文件名>: <原因>`」（`Dismiss` 关掉，下次打开成功时清除），不再静默；外部点击先读文件再清文件树，打不开时窗口保持原样。**模式**：不透明类型（`isOpaqueFile`：图片（SVG 除外）、PDF/Office、音视频、二进制）只有预览（`allowsMode`），命令面板、模式按钮、`Changed` 列表打开都切不到 `source` / `diff`。切 `diff` 拉补丁期间的输入保留，期间关掉的 Tab 不写回 |
| 5 | Mermaid 渲染进程 | 未启动 → 读 bundle → WebView 挂载 → `ready` → 卸载；每次启动是新的一代（`workerGeneration`） | `src/mermaid.tsx` 模块变量 | 半显式。WebView 卸载时，在途任务回到队首（`requeueOrphanedJobs`）。每个渲染任务 20 秒（`RENDER_TIMEOUT_MS`）无回复即失败，图表块显示错误而不是一直空白。任务记下它等的是哪一代；超时时只有当它等的正是当前这一代，才丢弃渲染器（`planJobTimeout`）：`ready` 之后卡死的渲染器也会被换掉，而旧任务的超时不会杀掉正在启动的新渲染器。丢弃时这一代作废，晚到的旧 bundle 不会把它复活。注：bundle 缺失且断网时 CDN 脚本加载失败，`load` 仍触发、`ready` 仍到达，渲染会很快报错；超时兜底的是请求卡住与渲染无回复 |
| 6 | 单个 Mermaid 块 | 渲染中 / 已渲染 / 出错 | `MermaidDiagramBlock` 信号，`followLatest` | 半显式。源码、主题或字体一变就回到「渲染中」（旧图撤下，显示 `id:mermaid-loading`），只有最新一次请求的结果（或错误）落地，慢的旧渲染晚到也丢弃 |
| 7 | 冷启动 | 先读 Recent（之后才记入启动目录）；两路并行：扫描初始目录（`refresh`）；打开初始文件 → 读 Finder 队列 → 读偏好 → 读 Ghostty 后再套一次主题 | `App` `appInitialized`、`recentLoaded` | 隐式，只跑一次 |
| 8 | Finder 队列 | 轮询中（150ms，最多 16 次）/ 已取到 / 停止；同一时刻只有一次读取 | `drainFinderOpenQueue` `inflightDrain` | 隐式，正常 |
| 9 | 终端会话 | 未启动 → 启动中（输入排队）→ 运行（未用 / 已用）→ 退出即关 Tab；最后一个 Tab 关闭时先补一个新 Tab | `src/TerminalPane.tsx` `TermTab`（`session` / `startedIn` / `gate` / `typed`）、`TerminalModel` | 半显式。面板第一次显示时才启动 Shell（`startShown`，启动时没有隐藏的登录 Shell）；面板隐藏时新开的 Tab 不启动，等面板再显示。启动中输入先排队（`createInputGate`）：Shell 第一次输出后安静 200 毫秒（`SHELL_QUIET_MS`）或满 3 秒（`SHELL_READY_MAX_MS`）才放行；终端应答（原生视图经 `Shared::send` 发出的 DA、光标位置、焦点等）不排队、不算「用过」，「用过」只由键入（`type_in`）或排队中的输入（`TermTab.typed`）判定。没用过的 Shell 跟随打开的目录（`shouldFollowCwd`、`followFolder`）；用过的保留目录与进程。换 Shell：偏好设置改默认 Shell 时只换没用过的 Tab（`adoptShell`）；下拉框里选 Shell，当前 Tab 没用过就换掉，用过就在新 Tab 里开这个 Shell（`pickShell`），用过的会话从不被杀。Shell 退出（Ctrl+D、`exit`）就关掉它的 Tab，同 Ghostty（`shellExited`）；是最后一个 Tab 时同时收起终端面板（`onEmpty`），补上的新 Tab 等面板再打开时才启动。已被替换的旧 Shell 迟到的 `exit` 不关任何 Tab（会话仍在运行就忽略）。`closeTab` 先补新 Tab 再删旧 Tab，Tab 列表从不为空（曾先置空：渲染读 `activeTab().session` 抛错，补 Tab 那步没执行）。启动失败（`[error] …` 写在屏幕上）的 Tab 里按任意键再试一次 |
| 10 | 浮层 | 命令面板（关 / `files` / `commands`）、偏好设置、查找栏 | `commandOpen` + `commandMode`、`fontDialogOpen`、`findOpen` / `findShown` | 隐式。查找栏属于编辑器：只在编辑器视图上显示（切到预览类 Tab 时隐藏，回来再显示）；`⌘F` 只在编辑器有焦点时打开（终端、预览里按不打开），显示时 `⌘F` 关闭；查找框里按 Esc 关闭；关闭后焦点回到编辑器 |
| 11 | 文件树视图 | `all` / `changed`，展开项，选中项 | `filterMode`、`expandedIds`、`selectedPath`；扫描结果 `snapshot` | 隐式。切换或关闭工作区时一起重置。扫描只认最新一次，且发起时的根目录仍是当前目录（`refresh` 的 `scanGeneration` 与根目录比对）：旧目录的慢扫描结束后不会覆盖新目录的文件树、Git 徽章、`⌘P` 列表和分支。`Changed` 列表含 git 报 `D`、磁盘上已没有的文件（排在最后），点开显示它被删掉的 diff。外部改名时跟着迁移（见 #14） |
| 12 | 窗口最小尺寸 | 正常 / 已纠正 | `lastEnforcedKey` | 隐式，正常 |
| 13 | 偏好设置 | 默认值 → 已存值 → Ghostty 补齐 | `initUserPreferences` | 隐式，正常 |
| 14 | 工作区与磁盘一致性 | 未变 / 目录变了（重扫）/ 只有 Git 变了 / 根目录不可用 | App `createWorkspaceDiskCheck`、`watchWorkspaceDisk`、`followRenames`；`src/workspace.ts` `readFolderStamps`、`detectRenames`、`withGitStatus`；`WorkspaceSnapshot.rootNotice` | 显式（I-014）。`nsh 0.4.0` 的 `fs/promises` 没有 `watch`，所以轮询：窗口 `active` 期间每 2 秒（`WORKSPACE_POLL_MS`）`stat` 一遍根目录和**已展开目录**的 `mtimeMs`（子项增删改名会改目录 mtime），有变化就整棵重扫（`refresh`），否则只跑一次 `git status` 并在结果变了时更新徽章与 `Changed` 列表（`withGitStatus`，不重扫）。比对不重叠（`serialize`），内部吞掉异常，下一次轮询再试。回到窗口（`lifecycle()` 再次变成 `active`）立即重扫一次。每次重扫（轮询、`⌘R`、保存后）与上一次同一根目录的扫描比对：同一父目录下恰好走了一个、来了一个同类条目即视为改名，`expandedIds`、`selectedPath`、`openTabs`、`activeFilePath` 与 `loadedFiles` 里该路径及其下的 key 一起迁移（`migratePath`），跨目录移动与多项同时变化不猜。根目录读不了时文件树换成一行说明（`id:workspace-notice`：`This folder was moved or deleted.` 或 `Cannot read this folder`），打开的 Tab 留着，各自显示 #3 的已移走横幅。重扫只认最新一次（`refresh` 的 `scanGeneration` 与根目录比对，见 #11），较早发起的重扫结束后直接丢弃 |

---

## 文件预览与 Mermaid 渲染契约

1. **类型判定、并发预热与大文件保护（`src/classify.ts` + `src/workspace.ts` + `src/themes.ts`）**：
   - `scanWorkspace()` 并发执行 `readGitStatus()`、`readGitBranch()` 与跨子目录 `Promise.all` 递归扫描，并在扫描完成后异步调用 `warmWorkspaceFiles()` 预热前 12 个 `≤ 256 KB` 的非音视频/非 PDF 文件；点击文件树时通过 `tryReuseLoadedFileSync()` 同步命中内存缓存，实现 `0ms` 瞬时打开与切换。
   - `computeSyntaxDecorations()` 采用模块级预编译正则、基于 `indexOf("\n")` 的零全量切分扫描（上限 `600` 行）与 48 项 LRU 缓存（`SYNTAX_DECORATION_CACHE`）；Tab 切换或主题切换时同步应用缓存装饰器，消除 10ms 延迟重绘与旧高亮闪烁。
   - CSV / TSV（`parseDelimitedRecords()`）：不含引号的文本走 `split` 快路径；含引号时按整段文本解析，引号内可含分隔符、换行与 `""`。单元格去掉首尾空格后像数字才转成数字，前导零（`007`）保留为文本。排序时空单元格在前、数字其次、文本最后，混合列不论原顺序都排成同一个结果；表格按文件重建（`TableBody` 按路径重新挂载），排序与列标题不会带到下一个表格。JSONL 不是 JSON 对象的非空行不再静默丢弃：行号记在 `TableData.invalidLines`，表格上方显示 `id:table-invalid-lines`。`generateQuickLookUrl()` 按文件缓存最新版本（`mtimeMs:size`）的 PDF 预览 `blob:` URL，避免重复拉起 `sips`，PNG 读完即删（见「术语与边界」）。
   - `.html` 预览（`PreviewPane` `preview-webview`）：`javaScriptEnabled={false}`，并由 `withPreviewCsp()` 在页面最前（有 doctype 时紧跟其后）插入 CSP `<meta>`：`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'`。浏览器同时执行页面里所有 CSP，页面自己再写的 CSP 只能更严、不能放宽。所以本地 HTML 里引用的远程脚本、图片、样式表都不加载（不向外发请求），只显示文件本身。
   - `video`（`.mp4`, `.mov`, `.m4v`, `.webm`）、`audio`（`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`）与 Quick Look 类（PDF、Office）在 `loadFile()` 中只调用 `fs.stat()` 获取字节数，按路径预览（`<Video src={filePath} />`、`sips`），绝不 `fs.readFile` 读入内存。
   - 图片（`.png`, `.jpg`, `.gif`, `.webp`, `.avif`, `.svg`）通过 `fs.readFile` 构造 `URL.createObjectURL(new Blob([bytes], { type }))`，由 `nsh-js` 在 Rust 侧零拷贝读取 `Blob` 的 `Arc<[u8]>`。
   - 未知扩展名文件按前 4 KB 判定，含 `\0` 字节则归类为 `binary`，展示只读 4 KB Hex + ASCII 视图。
   - **文件大小上限（`src/workspace.ts` `readFileBytesAndSize`，I-017）**：`MAX_EDITABLE_BYTES = 8 MiB`（`nsh 0.4.0` `fs.writeFile` 最多写 8 MiB，更大的文件本来也存不回去）。不超过上限的文件整读。超过上限的非图片文件不整读：先读前 4 KB（`BINARY_HEAD_BYTES`）判定，二进制只留这 4 KB 给 Hex 视图；文本读前 256 KiB（`LARGE_TEXT_HEAD_BYTES`）只读显示，`readOnly = "Larger than 8 MB — showing the first 256 KB, read-only"`（`id:read-only-banner`，永不写回）。`nsh 0.4.0` 的 `fs/promises` 没有部分读取，所以开头的字节由已授权的 `python3` 读出、以十六进制经 stdout 传回（`readFileHead`）。图片仍整读（`blob:` 需要全部字节；`fs.readFile` 超过 64 MiB 会失败，失败显示在 `id:open-error-banner`）。
   - **文本解码与保存回写（`src/workspace.ts` `decodeUtf8` / `encodeUtf8` / `saveFileText`）**：文本按 UTF-8 严格解码（`TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`，开头的 BOM 先剥掉并记在 `LoadedFile.bom`）。解码失败（GBK、Latin-1 等）时用替换字符显示，但副本标为只读（`readOnly = "Not UTF-8 — opened read-only"`）：编辑器 `readOnly`，编辑区上方显示 `id:read-only-banner`，永远不写回。保存写入 UTF-8 字节，`bom` 为真时先写回 BOM。保存后由新字节重算派生数据：表格行、SVG 的 `blobUrl` 与尺寸；`diffPatch` 清空（`.diff`/`.patch` 文件除外，它就是正文），下次进入 Diff 时重新拉取，保存时正处于 Diff 的 Tab 立即重拉。不透明类型从不写回（见「状态机清单」#4）。
2. **模式胶囊按钮显示规则（`App.tsx` `hasRichPreview`）**：
   - 仅对具备富预览能力的格式（`markdown`、`mermaid`、`table`、`html`、`image/svg+xml`）显示 `Preview` / `Code`（或 `Markdown`）切换按钮；当从左侧 `Changed` 列表以 `diff` 模式打开普通源码文件时，显示 `Diff` / `Code` 切换按钮；普通代码与二进制文件隐藏多余模式按钮。
3. **Mermaid 离屏光栅化流水线（`src/mermaid.tsx`）**：
   - 独立 `.mmd` / `.mermaid` 文件预览使用 `MermaidDiagramBlock`；Markdown 内的 ` ```mermaid ` 代码块由预览页在 WebView 内直接渲染为 SVG（见下条），两条路径共享 `buildMermaidConfig()` 生成的同一份 `mermaid.initialize` 配置，两条路径都用 `securityLevel: "strict"`（I-018 前独立 `.mmd` 用的是 `"loose"`：标签里的 HTML 与 `click` 回调会在渲染器 WebView 里执行）。
   - `MermaidRendererHost` 挂载在窗口可视区外（`left: -10000, top: -10000`），**仅在 `requestMermaidRender()` 首次被调用时按需延迟初始化**（打开普通代码、无 Mermaid 的 Markdown、表格或图片时不启动 WebKit 进程、不加载 2.5 MB Mermaid bundle）；初始化时优先从本机 VS Code / Cursor / Antigravity 的 `xicilion.markdown-viewer-extension-*` 扩展提取离线 Mermaid bundle（只存在内存，见「术语与边界」），缺失时回退 CDN。每个渲染任务 20 秒无回复即以错误结束；只丢弃该任务等的那一代渲染器（见「状态机清单」#5）。`loadMermaidBundleJs()` 导出这份 bundle 提取逻辑供 Markdown 预览页复用。
   - 渲染生成的 SVG 经 `inlineForeignObjects()` 将 HTML 标签转为原生 `<text><tspan>`（避免 `<canvas>` 污染断图），再按 2x Retina 缩放绘制到 Canvas 导出 PNG Base64，回传主线程转为 `blob:` URL 交由 `<Image />` 展示。结果缓存 `renderCache` 最多 24 张（`rememberRender`，最近用过的排最后），超出时删掉最久没用的一张并 `revokeObjectURL`。
4. **Markdown WebView 渲染契约（`src/MarkdownPreview.tsx` + `src/markdownPage.ts` + `vendor/markdown/`）**：
   - 渲染全部在 WebView（JSC）内完成，宿主只投递运行时与载荷并响应页面请求。`vendor/markdown/entry.mjs` 构建 markdown-it 15.0.3 管线（`html:true`、`linkify:true`、footnote / task-lists / CJK 安全去重 slug 的 anchor / GitHub alerts / highlight.js 11.12.0 common 子集 / KaTeX 0.19.1，`mermaid` 围栏保留为 `<pre class="mermaid">`），与 `page.mjs`（DOMPurify 消毒 + `window.__aed` 协议）一起经 `scripts/build-markdown-vendor.sh`（`bun install --frozen-lockfile` + `bun build --format iife`）打进 `src/markdownVendor.generated.ts`（已提交，`MARKDOWN_RUNTIME_JS` / `KATEX_CSS`（`url(fonts/*.woff2)` 全部内联为 `data:`、丢弃 woff/ttf 回退）/ `GITHUB_MARKDOWN_CSS` 自动明暗两变量版）。许可证见 `vendor/markdown/THIRD_PARTY_NOTICES.txt`。重建：`sh scripts/build-markdown-vendor.sh`。构建把 `entry.mjs + page.mjs + bun.lock` 的 sha256 前缀写成 `globalThis.AedMarkdown.buildId`（防 `dist/` 与生成文件漂移，测试断言 `MARKDOWN_RUNTIME_JS` 包含同一 buildId）。
   - 页面壳层 `buildPreviewShellHtml()` 只含 `<meta charset>`、严格 CSP（`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`）、三个 `<style>` 块与空 `<main>`/`<nav>`，**不含任何 `<script>`**；运行时只在 `onLoad` 注入一次（`page.mjs` 顶部有 `!window.__aed` 安装守卫，重复注入不产生重复监听器），随后每次 `sendRender` 只发 `__aed.render(payload)`（绕过 HTML 解析器与 `script-src`，见踩坑记录）。
   - 协议：宿主 `__aed.render({renderId, path, markdown, themeCss, scrollY, mermaidConfig})` / `__aed.setTheme` / `__aed.setImages` / `__aed.mermaidReady` / `__aed.mermaidUnavailable`；页面上行 `link`（非 `#` 链接）、`images`（非 `https:`/`data:` src 去重，≤200 条）、`scroll`（~200ms 节流）、`needMermaid`。`handlePreviewMessage` 在 `src/markdownPage.ts` 中纯函数化：外链仅 `http:`/`https:`/`mailto:`（大小写不敏感）走 `openUrl`，其余 scheme 一律 `none`；相对/绝对/`file://` 路径解码 `%XX`、剥 `#`/`?` 后相对 Markdown 文件目录解析并 `openFile`，`javascript:`/`data:`/`vbscript:`/`#` 锚点不动作；图片仅解析 `png jpg jpeg gif webp avif svg bmp ico` 本地路径，宿主按 `classify.ts` MIME 表读取并以 `data:` 回传（单图 20 MB 上限，失败回 `null` 加 `aed-img-missing`）。
   - 消毒：DOMPurify 默认配置（保留 `id`/`class`、任务列表 `input[type=checkbox][disabled]`、KaTeX MathML/SVG、`<details>/<summary>`），默认即禁 `<style>` 与全部 `on*` 属性。
   - TOC 与栏宽：TOC 仅当视口 ≥1120px 且 ≥2 个 H1–H3 时显示；显示时页面加 `body.aed-has-toc`（`padding-right: 276px` = 220 TOC + 24 右距 + 32 间隙），阅读栏在 TOC 左侧空间内居中，绝不重叠。
   - Mermaid 尺寸：`fitMermaidSvgs()` 按 viewBox 取天然宽，`scale = clamp(colW/natW, 0.66, 1)`；`height:auto` 消除上下留白；`scale×natW > colW` 时容器 `overflow-x:auto` 横向滚动而非继续缩小。每次渲染与 `resize` 后重算。预览内 Mermaid 用正文 UI 字体（`buildMermaidConfig(theme, "")`）。
   - Keep-alive：`markdownMounted` 信号一旦置真不再卸载——切到非 Markdown 视图时外层 `display:none` 隐藏而非卸载，页面与滚动状态保留；切换 Markdown 文件复用同一 WebView 发新 `render`；主题/字体变化只发 `setTheme` 不重解析；滚动记忆为进程内 `Map<path, y>`（无 `Storage` 键）。
   - 调试通道：宿主事件 `aed.preview.eval` 注入任意页面 JS、页面 `__dbg:` 前缀消息经 `host.post("aedPreviewDebug")` 回传，仅真机测试使用，打包宿主不发送。
   - `nsh 0.4.0` 无头 `nsh test` 不执行 WebView 页面 JS（见踩坑记录），所以页面行为只能用 `--target macos` 真机窗口验证。这类测试用系统真实输入，会占用用户的鼠标和键盘，只在用户同意时跑；脚本不入库。

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
   - `launcher` 解析命令行参数：`file://[localhost]/…` 做百分号解码（`%00` 不解码），`#L<line>[C<col>]` 一律当片段；路径先按原样 `realpath`，存在就不剥任何后缀（文件可以叫 `notes:12`），不存在才剥 `#L<line>` / `:line(:col)` 再试，剥出的行列以 `:line:col` 附在路径后交给 App 跳转。有文件参数时文件优先：第 1 个写入 `AED_OPEN_FILE`（清除 `AED_ROOT` / `NATIVE_EDITOR_ROOT`），第 2 个起写入本进程自己的队列 `open-<pid>`（`execv` 后 pid 不变），同一个窗口全部作为 Tab 打开；没有文件参数时第 1 个目录写入 `AED_ROOT`。随后设置 `DYLD_INSERT_LIBRARIES=@executable_path/libFinderBridge.dylib` 并 `execv("AedCore")`。
2. **`scripts/finder_bridge.m`（`libFinderBridge.dylib`）**：
   - 在 `__attribute__((constructor))` 初始化时**立即调用 `unsetenv("DYLD_INSERT_LIBRARIES")`**（防止用户在内置终端里运行的子进程继承该环境变量导致崩溃或告警）。
   - Method Swizzle `NSApplication setDelegate:` 并通过 `setOrReplaceMethod` 向宿主 Delegate 注入或覆盖 `application:openFile:`、`application:openFiles:`、`application:openURLs:` 与 `windowWillResize:toSize:`：
     - 一次打开事件（Finder 里选中 N 个文件）是一批：所有文件进同一个窗口作为 Tab，每个文件夹各开一个窗口。
     - **冷启动首个外部目标**（`NSApplicationDidFinishLaunching` 前及完成后 `1.5s` 内且未通过 `--args` 指定初始目标）：这一批文件全部写入本进程队列 `open-<pid>`（没有文件时写第 1 个文件夹）并唤醒当前窗口，由 `App.tsx` 以无文件树独立模式（`workspaceRoot = ""`）直接展示；
     - **运行中再次点击外部文件**：调用一次 `/usr/bin/open -n <Aed.app> --args <path1> <path2> …` 拉起一个全新的独立 Aed 窗口进程（不带左侧文件树），由它的 `launcher` 按上条分发，并在 AppKit 层锁定窗口最小尺寸为 `760 × 520`（`setContentMinSize:` / `setMinSize:`）。
   - **退出保护（I-016，文件末尾独立的一段，自带 `constructor`，不改上面的代码）**：在 `NSApplicationDidFinishLaunching` / `NSWindowDidBecomeKey` 时给宿主窗口 Delegate 的 `windowShouldClose:` 与 App Delegate 的 `applicationShouldTerminate:` 各挂一次钩子（保存原实现，各类只挂一次）。窗口标题以 ` — Edited` 结尾时：关闭按钮返回 `NO`、系统退出返回 `NSTerminateCancel`，并在下一轮 run loop 选中 App 的 `Quit Aed` 菜单项，由 JS 弹未保存确认框；标题不带标记、或菜单里找不到该项时，调用宿主原实现，行为与以前相同。菜单项在下一轮 run loop 重新查找后再触发（App 可能在此期间重建菜单）。**JS 无响应兜底**：上次转交后 4 秒内（`AED_QUIT_RETRY_SECONDS`）又来一次关闭或退出、标题仍带标记时，弹原生 `NSAlert`「Quit Aed without saving?」（`Cancel` / `Quit Anyway`），选 `Quit Anyway` 走宿主原实现，避免页面卡死时只能强制退出。无头测试测不到原生部分，需要 `--target macos` 或打包后手测。
3. **`scripts/set_default_handlers.m`**：
   - 先通过 `LSCopyDefaultRoleHandlerForContentType` 查询当前默认打开程序，已绑定 `dev.byronwayne.aed` 的 UTI 直接跳过（避免重复触发 macOS `CoreServicesUIAgent` 确认弹窗），并对 UTI 去重、过滤未声明的 `dyn.*` 动态 UTI。
   - 默认仅注册 8 个核心文档与数据 UTI（Markdown、Mermaid、JSONL、JSON、CSV、TSV、Plain Text、Diff/Patch）；传入 `--all` 时额外注册常用源码 UTI，也可直接传入指定扩展名（如 `set_default_handlers yaml toml`）。
   - 只在用户要求时运行：`sh scripts/package-macos.sh --set-default`，或 DMG 里的 `Install & Set Default.command`（I-018 前首次安装会自动运行，不问用户就接管默认文本编辑器）。`install.sh` 目前仍在每次安装后运行它，并提示「set as default document editor」。
   - `Info.plist` 的 `CFBundleDocumentTypes`：文本、源码、Markdown、JSON、CSV 等具体类型为 `Editor` / `Default`；`public.data`（任意文件）单独一组，为 `Viewer` / `Alternate`，只让 Aed 出现在「打开方式」里，不声明自己是所有文件的默认编辑器。
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
| 欢迎页是一张海报 | 3 个实心色面：左下墨色块（纯粹几何色块，不放「Open Folder」文字或按钮以免破坏海报感或误触系统选目录弹窗）；分栏线右侧的石色月牙，外缘从墨色块右上角起一条光滑的 1/4 椭圆弯到窗口右上角（起点切线竖直，与分栏线相切），内缘是一条三次贝塞尔曲线从右上角贴右边缘落下、贴底边收到墨色块底端；月牙内缘以下、直到右边缘和底边全部是红色扫面。红色先画成一个被月牙完全盖住上边的四边形，月牙后画，因此月牙外缘不会透出红色抗锯齿毛边。标题 `Aed` 采用 `Helvetica Neue` 粗体、紧字距单行展示；标签采用 Sentence case（`Recent`）。窗口最小尺寸锁定为 `760×520pt`（`MIN_WINDOW_WIDTH` / `MIN_WINDOW_HEIGHT` + AppKit `NSWindow.minSize`），`posterGrid()` 对画布尺寸施加 `520×380pt` 结构下限并按列宽与顶栏净空约束字号，保证标题绝不拆词折行、文字不压到色块上 | `App.tsx` `PosterFields` / `WelcomePanel`、`scripts/finder_bridge.m` |
| 颜色跟随主题重绘 | `Canvas` 只在 `draw` 内读到的 signal 变化时重绘，所以主题色必须在 `draw` 里读（`Icon` 的 `tint` 与 `AppLogo` 的 `ink` / `accent` 均支持传 accessor） | `src/icons.tsx` `Icon` / `AppLogo` |
| 预览阅读排版与 TOC 强调 | Markdown 预览遵循同一套规则：阅读栏 `860px` 居中、4px 网格、无阴影/渐变；标题为 `foreground` 600 无彩色，标题下与表格用 `--border` 发丝线；行内代码 `card` 底、代码块 `sidebar` 底 + `editorFont`；引用/GFM Alerts 用 `2px` 左侧条（note→`syntax.property`、tip→`syntax.string`、important→`syntax.type`、warning→`syntax.number`、caution→`ui.accent`）；链接下划线用 `border`，悬停才升 `accent`；TOC（视口 ≥1120px 且 ≥2 个 H1–H3 才显示）唯一强调用法是当前小节 `foreground` + `2px accent` 左条 | `src/markdownPage.ts` `buildPreviewThemeCss` |
| 只有图标的按钮有名字 | 每个只画图标的按钮都设 `accessibilityLabel`（读屏与测试的 `label:` 选择器用它）：Tab 关闭「Close <文件名>」、标题栏「Toggle sidebar」/「Toggle terminal」、侧栏「Show all files」/「Show changed files」、偏好设置「Close preferences」、图片 / PDF / Mermaid 缩放「Zoom out」/「Zoom in」、终端「New terminal tab」。新加图标按钮时同时补上并加进 `App.test.tsx` › every icon-only button has an accessible name。悬停提示（`tooltip`）尚未加，待视觉方向确定后统一做 | `App.tsx`、`src/Sidebar.tsx`、`src/PreviewPane.tsx`、`src/mermaid.tsx`、`src/TerminalPane.tsx` |

**为什么 `nsh.json` 的 `theme.cssVars` 也是 Industrial**：`nsh 0.3.0` 的 TS 应用不能在运行时改 design tokens（`set_tokens` 只在 Rust 侧暴露，`~/.nsh/source/crates/nsh-js/src/env.rs`），`bg-primary`、`text-muted-foreground` 等类名永远取 `nsh.json` 里的静态值。以前这里是中性灰 + 白色 `primary`，所以主题切到暖色时出现「黑白两套颜色」。现在静态 tokens 与默认主题同色；需要跟随其它主题的界面元素，用 `style` 读 `theme.ui.*`，不用 token 类名。

---

## 关键决定与踩坑记录（Verified Facts & Traps）

1. **`nsh 0.3.0` 桌面无头测试平台参数**：
   - `nsh/test` 的 `open("./App.tsx")` 默认使用 `{ platform: "ios", width: 390, height: 844 }`，会禁用 `fs/promises` 与 `process`。在 `App.test.tsx` 中必须显式传入 `{ platform: "macos", width: 1280, height: 800 }`。
2. **`process.run` / `process.spawn` 必须显式传 `{ cwd }`（`nsh 0.3.0`）**：
   - 未配置宿主 `dataDir` 时省略 `cwd` 会直接抛错；且 `cwd` 必须落在 `nsh.json` 的 `capabilities.fs.write` 授权目录内（`${homeDir}` 或 `/tmp`）。`nsh.json` 中绝不能写 `~` 或 `$HOME`，必须写 `${homeDir}`。
3. **JSX 标签与内置控制流（`nsh 0.3.0`）**：
   - 所有组件标签必须大写开头（`<View>`、`<Text>`）；小写 HTML 标签编译失败。`<If when={...}>` 与 `<Each of={...}>` 是编译器注入的全局宏，**严禁从 `"nsh"` 导入**。
4. **冷启动默认展示 `WelcomePanel` 开屏页，绝不自动进入旧工作区或扫描 `$HOME` / `/`，且支持随时关闭工作区返回开屏页**：
   - 早期版本在未传工作区时回退 `os.homedir()` 或自动恢复 `aed.recentWorkspaces[0]`（如历史遗留的 `data` 目录），导致每次打开 Aed 或等待 LaunchServices `odoc` 事件时总是强制跳进上次的目录页面（`EmptyEditorPanel` + 左侧文件树），无法停留在开屏页。现 `getInitialWorkspaceRoot()` 在无显式工作区（`AED_ROOT`）时返回 `""`：冷启动默认隐藏左侧文件树并渲染瑞士网格开屏页 `WelcomePanel`（`id:welcome-panel`），`Storage` 中的 `aed.recentWorkspaces` 仅在开屏页右侧 `Recent` 列表中展示供用户主动点击打开，绝不自动加载为当前工作区。
   - 一旦用户主动打开工作区（`workspaceRoot().length > 0`）且当前无打开的 Tab（`activeFile() === undefined`），编辑区渲染安静的低对比度快捷键提示页 `EmptyEditorPanel`（`id:empty-editor-panel`）；用户可随时通过 `Close Folder`（`⌘⇧W`、菜单栏 `File ▸ Close Folder`、命令面板或空态页 `id:empty-editor-close-folder`）将 `workspaceRoot` 置空并重置工作区状态，随时返回 `WelcomePanel` 开屏页。
   - 左侧文件树顶部目录名（`id:sidebar-workspace-title`）为纯静态标题展示，绝不绑定 `osascript` 选目录弹窗，避免误触文件树顶部时弹出系统模态窗；切换/打开目录仅通过菜单栏、`⌘O`、命令面板或空态页 `id:empty-editor-open-folder` 触发。文件树顶栏只放目录名与 All / Changed 切换，不放打开/关闭文件夹按钮（入口已有 4 处，按钮只增加误触）。
   - 外部点击打开单文件（Finder / Herdr / 终端链接点击或 `AED_OPEN_FILE`）一律以**不带左侧文件树的独立窗口**（`workspaceRoot = ""`）打开：若当前窗口已处于运行态，`finder_bridge.m` 通过 `open -n <Aed.app> --args <path…>` 为这一批文件新开一个不带文件树的独立 Aed 窗口；若为冷启动首次拉起，直接将文件载入当前无文件树窗口，绝不把外部单文件塞进旧工作区目录树里。拖拽到窗口上的文件例外：不论在不在当前工作区内，都在本窗口作为 Tab 打开并保留文件树（见「状态机清单」）。关闭或切换含未保存修改（`dirty`）的 Tab/工作区时弹出确认框（`id:unsaved-changes-dialog`）。状态栏仅在当前工作区确属 Git 仓库（`branch` 非空）时展示分支名，绝不在非 Git 目录伪造 `main`。
5. **`DYLD_INSERT_LIBRARIES` 泄漏坑**：
   - 若不在 `finder_bridge.m` 的构造函数里立即 `unsetenv("DYLD_INSERT_LIBRARIES")`，内置 PTY 终端里启动的所有 macOS 系统命令都会尝试加载 `libFinderBridge.dylib`。
6. **`nsh/base` 无样式原语（`Select` / `Command` / `Tree`）必须传完整浮层与行渲染**：
   - `Select` 原生不带任何背景、边框或字色（默认字色为纯黑 `#000000`）。使用时必须显式传入 `placement`、`popupClass` / `popupStyle` 及 `renderItem`（显式指定主题 `foreground` 字色、字体与选中/高亮态背景），否则在深色主题下会出现「透明底 + 黑字」悬浮现象。
7. **LaunchServices `_LSOpenURLsWithCompletionHandler() failed with error -10825` 兼容性坑**：
   - 在高版本 macOS SDK（如 macOS 27.0）机器上运行 `clang` 编译 `launcher.c`、`finder_bridge.m`、`set_default_handlers.m` 时，若未显式指定 `-mmacosx-version-min=11.0`，生成的 `Contents/MacOS/Aed` 主可执行文件 `LC_BUILD_VERSION` 会写入 `minos = 27.0.0`。低版本 macOS 的 LaunchServices 在执行 `open /Applications/Aed.app` 时检查主二进制 `minos` 与 `Info.plist` `LSMinimumSystemVersion`，直接报错 `-10825`（`kLSIncompatibleSystemVersionErr`）。必须在编译、打包及 `install.sh` 中将 `LSMinimumSystemVersion` 与 `LC_BUILD_VERSION.minos` 统一锁定为 `11.0`。

8. **在 `effect` 的一次运行里 `process.spawn` 的子进程，会在该 `effect` 下次运行时被结束（`nsh 0.3.0` 实测）**：
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

---

## 试过不做的方案（Tried & Rejected）

- **xterm.js WebView + `python3` `pty.fork()` 帧协议桥（I-019 到终端改原生之间）**：能用，但每个键要经过页面 JS → `postMessage` → TSX → base64 帧 → Python 进程 → PTY，输出再原路返回，打字有可感的延迟；还要维护 380 KB 的 vendored 运行时、页面协议与回放缓冲。改为 libghostty-vt + 原生视图，键在 Rust 里直接写 PTY。代价是混合模板：首次 `nsh check` 编译 crate 约 68 秒（早先「混合模板太慢」的判断按此改写，增量构建在 1 秒内），并多一个要下载校验的 27 MB 静态库。
- **使用 `qlmanage` + 底部外部打开操作栏预览 PDF**：`qlmanage -t` 在部分系统环境下会弹窗或阻塞，且底部常驻 `Open in Preview` 操作栏喧宾夺主；已改为直接调用 macOS 内置 `sips -Z 1800 -s format png` 生成 2x Retina 预览图，并以暖白纸张底衬（`#f7f4ee`）+ 缩放控制条承载，避免透明底黑字在深色主题下不可读。
- **在底部 24pt 状态栏放置刷新图标与主题/字体切换按钮**：在非 Git 目录下左下角会留下孤立无文字的 `↻` 图标（语义不明），而右下角的主题下拉、字体下拉与单点循环切主题按钮紧贴终端输入行与窗口缩放边缘，极易误触切走配色或弹出大菜单；现 `StatusBar` 统一改为纯只读状态展示，主题/字体配置与工作区刷新统一走 `⌘,`（Preferences）、应用菜单与 `⌘⇧P` 命令面板。
- **在 Markdown 预览中用字符画（`mmd2txt`）替代矢量图**：终端适合字符画，但桌面 GUI 编辑器用户期望高分辨率图表；因此采用隐藏 `WebView` + SVG `<foreignObject>` 内联 + 2x Retina PNG 光栅化方案。
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
| 类型检查 | `nsh check` | 编译 `native/` crate 加 TS 类型检查：首次约 68s，增量约 1s（`nsh 0.4.0`），0 errors |
| 单测与桌面无头 E2E | `nsh test --trace` | 114 项（93 项 TSX + 21 项 Rust）约 2 分钟（`nsh 0.4.0`，2026-11-13 实测；多数时间花在真实 Shell 与磁盘轮询的 E2E 上；测试里的 Shell 不读用户的启动文件，见「测试 Shell 的私有目录」），覆盖 10 类文件预览、Mermaid 渲染、主题切换、Ghostty 解析、终端会话与真实 Shell |
| libghostty-vt 固定版本 | `sh scripts/fetch-ghostty-vt.sh` | 1.0.1 zip 与 `libghostty-vt.a`（macos-arm64_x86_64）SHA-256 都对上才拷入；已有且哈希对时不下载 |
| 桌面真机窗口测试 | `nsh test App.tsx --target macos` | AppKit 真机窗口逐步交互验证 |
| 打包体积与速度 | `nsh package --target macos` | 增量打包 ~64ms，`.app` 体积 ~37 MB |
