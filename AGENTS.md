# native-editor contributor entrypoint

Lightweight macOS native editor, multi-format previewer (`code`, `markdown`, `mermaid`, `table`, `diff`, `image`, `video`, `audio`, `quicklook`, `binary`), and interactive PTY terminal built on Native Shell (`nsh 0.3.0`, pure TSX `--template ts`). No plugin system or network backend.

## 1. 目录与边界测试（The Boundary Test）

| 目录 / 文件 | 职责 | 放进这里的判断标准 |
|---|---|---|
| `App.tsx` | 窗口壳层、标题栏、可拖拽分栏（`ResizablePanelGroup`）、Tab 与快捷键状态编排 | 改这行是在改顶层窗口布局/状态路由，还是具体面板内部渲染？ |
| `src/` | 业务模块：`workspace.ts`（目录/Git/Finder 队列）、`classify.ts`（类型判定/CSV-JSONL/Hex/sips）、`PreviewPane.tsx`、`mermaid.tsx`、`Sidebar.tsx`、`TerminalPane.tsx`、`themes.ts`、`icons.tsx` | 纯解析逻辑与 I/O 外壳分离；读取或探测失败返回 `null`/`undefined`，不伪造空数据 |
| `scripts/` | macOS 打包脚本（`package-macos.sh`）、Finder 桥接动态库（`finder_bridge.m`）、CLI 启动器（`launcher.c`）、UTI 注册（`set_default_handlers.m`） | 是在改 `.app` Bundle 注入、签名、DMG 或 LaunchServices 关联吗？ |
| `App.test.tsx` + `fixtures/` | `nsh test` 免预启动单测与桌面无头端到端契约测试及固定测试样本 | 不依赖外部服务、不改用户 `/Applications` 或配置即可跑通吗？ |
| `.scratch/` | 临时截图、一次性排查产物与手工原型（已 `.gitignore`） | 是一次性排查数据或草稿吗？严禁放进 `docs/` 或提交入库 |

## 2. 按任务读取文档（不要全量扫 `docs/`）

- 架构、模块契约、持久化标识与踩坑记录：`DESIGN.md`
  - 改 `src/classify.ts` / `src/PreviewPane.tsx` / `src/mermaid.tsx` → 读 `DESIGN.md「文件预览与 Mermaid 渲染契约」`
  - 改 `src/workspace.ts` / `scripts/` / `nsh.json` → 读 `DESIGN.md「术语与边界」` 与 `DESIGN.md「Finder 桥接与打包流水线」`
  - 改 `src/TerminalPane.tsx` / `src/themes.ts` → 读 `DESIGN.md「内置 PTY 终端与 Ghostty 配置探测」`
- 待修问题与待办队列：`docs/issues/INDEX.md`
- 历史归档：`docs/archive/`（**日常开发严禁读取**）

## 3. 常用命令

```sh
nsh check                           # TypeScript 原生类型检查（~0.2s）
nsh test --trace                    # 免预启动单测 + 桌面无头 E2E 测试（~1.0s）
nsh test App.tsx --target macos     # 真机 AppKit 窗口交互测试
nsh run --target macos              # 开发热重载宿主
nsh package --target macos          # 仅打包 .nsh/out/Native Editor.app（不写 /Applications）
sh scripts/package-macos.sh         # 完整构建、签名、装到 /Applications、注册默认打开方式（改完用户可见的功能后直接跑）
```

## 4. 必须遵守的 6 条规则

1. **改完就装上**：用户能看到的改动在测试通过后，直接跑 `sh scripts/package-macos.sh` 并 `open "/Applications/Native Editor.app"`，不要停下来问。先用 `pgrep -fl NativeEditor` 查 app 是否在跑；在跑就先问用户，因为脚本会删掉旧 app，未保存的编辑会丢。测试本身只用 `fixtures/`，不碰用户文件。
2. **协议与持久化先行**：修改 `nsh.json` 权限、`Storage` 键名（`native-editor.*`）、环境变量（`NATIVE_EDITOR_*`）或 `/tmp/native-editor-*` 路径前，先更新 `DESIGN.md「术语与边界」`，写清旧缓存/旧配置兼容行为并配测试。
3. **修 Bug 先红后绿**：修任何 bug 必须先在 `App.test.tsx` 写出旧代码 FAIL（Red）、新代码 PASS（Green）的测试；改完源码运行 `ub-mode`（`crapper` / `dryer`）并汇报数字。
4. **实测与版本绑定**：NSH 与系统命令行为必须绑定实测版本（当前 `nsh 0.3.0`）；写文档引用代码前当场重读源文件核实；`App.test.tsx` 中调用 `open("./App.tsx", ...)` 必须显式传 `{ platform: "macos", width: 1280, height: 800 }`。
5. **完成定义（DoD）**：`nsh check` 与 `nsh test --trace` 全部通过 + `DESIGN.md` 同步更新 + `docs/issues/INDEX.md` 状态更新 + `doc-lint` 零告警；工作区有其它改动时一律用 `git commit --only -- <paths>` 提交。
6. **按需独立审查**：当改动触及 `nsh.json` 权限边界、`scripts/` 原生 C/ObjC 桥接与签名、或 `Storage`/队列协议时，交由不同于当前作者的模型独立审查 `git diff`。

## 5. Issue 自动处理闭环

当被要求「修 Issue」或推进 `docs/issues/INDEX.md` 时：
1. 只认领 `status: ready` 的第一条 `I-<id>`；遇到 `needs-decision` / `external-blocked` / `ops-approval` 只向用户汇总提问，不擅改代码。
2. 按卡片 `verify` 跑出 Red → 最小化修改源码跑出 Green → 跑全量 `nsh check && nsh test --trace` 及 `ub-mode`。
3. 用 `git commit --only -- <paths>` 原子提交，同步更新 `DESIGN.md`，在 `docs/issues/INDEX.md` 将条目移入 `done`（记录 commit SHA 与测试名），并立即删除已 `done` 的单张 `docs/issues/I-*.md`。
