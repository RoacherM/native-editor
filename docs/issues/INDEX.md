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
| I-001 | `DESIGN.md` | `nsh.json` 进程白名单收紧到 `git`/`python3`/`sips`/`osascript` | SHA_PLACEHOLDER | `App.test.tsx` › enforces least-privilege process.execute allowlist | 2026-11-06 |
| I-000 | `DESIGN.md` | 修复 `DYLD_INSERT_LIBRARIES` 泄漏并移除冗余 `qlmanage`/`open` 操作栏 | `e1cf916` | `App.test.tsx` | 2026-04-12 |
