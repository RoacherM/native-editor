---
title: Issue 与待优化项队列
description: 面向 Agent 自动开发、测试与修复的 6 态原子任务看板。
---

# Issue 队列

Agent 自动处理规则：只认领 `ready` 栏的条目；修完用 `git commit --only -- <paths>` 提交，更新 `DESIGN.md`，将条目移入 `done` 并删除已 `done` 的单张卡片文件。

## 1. Ready（Agent 可直接认领）

| ID | 优先级 | 子系统 | 标题 | 验证命令 |
|---|---|---|---|---|

## 2. Needs Decision（等用户拍板）

| ID | 子系统 | 需拍板问题 | 选项与推荐 |
|---|---|---|---|---|

## 3. External Blocked / Ops Approval（跨仓阻塞或需生产授权）

| ID | 类型 | 阻塞方 / 需授权操作 | 说明 |
|---|---|---|---|---|

## 4. Verifying（已提交，待环境核验）

| ID | 子系统 | 标题 | Commit | 回归测试 |
|---|---|---|---|---|

## 5. Done（已闭环，单卡已删）

| ID | 子系统 | 标题 | Commit | 回归测试 | 日期 |
|---|---|---|---|---|---|
| I-010 | `DESIGN.md` | 关闭 I-009 遗留的 4 个状态缺口：任意文件拖入工作区窗口都作为 Tab 打开并保留文件树；当前 Tab 每 1.5 秒比对磁盘（干净 Tab 自动刷新，脏 Tab 显示 `Reload from Disk` / `Keep My Edits` 冲突横条）；Mermaid 渲染任务 20 秒超时报错；未输入过的终端跟随打开的目录，并修复重启后旧 Shell 迟到 `exit` 结束新会话的竞态与 `effect` 内 `spawn` 被下次运行结束的坑 | `4687974` | `App.test.tsx` › dropping any file onto a workspace window opens it as a tab and keeps the file tree；an open clean tab shows changes made on disk without reopening；a tab with unsaved edits that changed on disk asks to keep the edits or reload；a terminal the user has not typed into moves to the folder that opens；a timed-out Mermaid job leaves whichever queue holds it, once | 2026-11-09 |
| I-009 | `DESIGN.md` | 隐式状态机显式化：`src/session.ts` 收口窗口会话状态机（home / workspace / loose 穷举迁移表），并修复 4 处状态泄漏：工作区内文件拖入保留文件树、未保存确认框不可被第二个守卫动作顶替、重开缓存文件按磁盘 `mtime:size` 戳自动刷新（脏缓冲不覆盖）、Mermaid WebView 卸载时在途任务重新排队；`DESIGN.md「状态机清单」`列出 13 个状态机 | `e73bffd` | `App.test.tsx` › window session state machine (src/session.ts)；dropping a file from the open folder keeps the file tree (workspace-file, not loose)；a second guarded action cannot replace an open unsaved-changes prompt；reopening a file shows changes made on disk after Aed first read it | 2026-11-09 |
| I-008 | `DESIGN.md` | 冷启动不再强制自动打开 `aed.recentWorkspaces[0]` 旧工作区（始终进 `WelcomePanel` 海报页保留 `Recent` 列表）、移除开屏页左下色块上的 `Open Folder` 按钮文字防误触，且 `finder_bridge.m` 初始冷启动窗口改为基于 `NSApplicationDidFinishLaunchingNotification` 判定 | `5c711d4` | `App.test.tsx` › clean launch without workspace hides file tree, shows Aed welcome panel, and migrates legacy storage | 2026-11-09 |
| I-007 | `DESIGN.md` | 外部文件点击一律以无文件树独立窗口打开：运行态通过 `open -n <Aed.app> --args <path>` 新开独立无侧栏窗口，冷启动清空自动恢复工作区，分离独立无信号依赖的队列定时器并支持 `file://`/`#L<line>`/`:line:col` 归一化 | `039a263` | `App.test.tsx` › supports returning to welcome page, static sidebar title, dirty-tab guard, and loose external file without hijacking workspace | 2026-11-07 |
| I-006 | `DESIGN.md` | 文件打开与渲染速度优化：并发目录/Git 扫描、工作区小文件预热与 0ms 同步 Tab 复用、Mermaid WebView 按需懒加载、语法高亮 LRU 缓存与预编译正则、CSV 无引号快路径及 PDF QuickLook 缓存 | `61b6a29` | `App.test.tsx` › formats binary bytes as hex + ASCII dump and computes syntax decorations across themes | 2026-11-07 |
| I-005 | `DESIGN.md` | 工作区与文件交互逻辑重构：静态侧栏标题防误触弹窗、`Close Folder` 返回开屏页、纯只读底部状态栏防误触、脏文件拦截确认框及外部单文件独立打开 | `ba99199` | `App.test.tsx` › supports returning to welcome page, static sidebar title, dirty-tab guard, and loose external file without hijacking workspace | 2026-11-07 |
| I-004 | `DESIGN.md` | 锁定 `LSMinimumSystemVersion` 与 Mach-O `LC_BUILD_VERSION` 至 macOS 11.0，修复低版本 macOS 启动报错 `-10825` | `d01f3fe` | `App.test.tsx` › normalizes Mach-O LC_BUILD_VERSION minos/sdk to macOS 11.0 / 14.0 to prevent LaunchServices -10825 error | 2026-11-06 |
| I-003 | `DESIGN.md` | 开屏海报仅在首次无工作区时显示，工作区内空 Tab 使用安静提示页并自动恢复最近工作区 | `9c00cb9` | `App.test.tsx` › clean launch without workspace hides file tree, shows Aed welcome panel, and migrates legacy storage | 2026-11-06 |
| I-002 | `DESIGN.md` | Aed 品牌重命名、Industrial 9 轮 UI 打磨、窗口最小尺寸锁定与 PDF 2x 纸张底衬预览 | `e55382d` | `App.test.tsx` › Aed E2E desktop UI, multimedia preview & Ghostty terminal | 2026-11-06 |
| I-001 | `DESIGN.md` | `nsh.json` 进程白名单收紧到 `git`/`python3`/`sips`/`osascript` | `254ef6b` | `App.test.tsx` › enforces least-privilege process.execute allowlist | 2026-11-06 |
| I-000 | `DESIGN.md` | 修复 `DYLD_INSERT_LIBRARIES` 泄漏并移除冗余 `qlmanage`/`open` 操作栏 | `e1cf916` | `App.test.tsx` | 2026-04-12 |
