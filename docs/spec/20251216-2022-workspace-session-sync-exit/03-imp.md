---
id: imp_syrb2kgs
type: implementation
title: Workspace Session Sync /exit - 实施
status: finalized
created_at: 2025-12-16T12:22:12.335Z
updated_at: 2025-12-16T04:58:35.000Z
---

# Workspace Session Sync /exit - 实施

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

# Workspace Session Sync（CLI/Web/Telegram）- 实施计划

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft |  |
| Owner | Codex |  |
| Created | 2025-12-16 |  |
| Updated | 2025-12-16 |  |
| Related Requirements | 01-req.md | requirement v1 |
| Related Design | 02-des.md | design v1 |

## Goal
实现“一个 workspace 一个 active thread”，并让 CLI/Web/Telegram 三端统一恢复该 thread，实现跨端无缝衔接；同时 `/cd` 切换 workspace 时不丢上下文。

## Constraints
- 不做数据库 schema 变更（复用 `.ads/state.db` 的 `kv_state`）。
- 未经明确许可不删除/覆盖任何数据库文件。
- 未定稿本实施计划前不写业务代码。
- Web/前端若有改动，交付前必须 `npm run build`。

## Task Breakdown

### T1: 新增 WorkspaceSessionStore（读写 active threadId）
- 文件：`src/state/workspaceSessionStore.ts`（或放在 `src/utils/`，以项目风格为准）
- 内容：
  - `getActiveThreadId(workspaceRoot): string | undefined`
  - `setActiveThreadId(workspaceRoot, threadId): void`
  - `clearActiveThreadId(workspaceRoot): void`
  - 内部使用 `getStateDatabase(path.join(workspaceRoot, '.ads', 'state.db'))`
  - `kv_state(namespace='workspace_session', key='active_thread_id')`
- 验证：
  - 单元测试：写入/读取/清空行为；空值/非法值处理（trim）。

### T2: CLI：启动时恢复 active thread；每轮写回；reset 清空
- 文件：N/A（命令行入口已移除）
- 改动点：
  - 在 `main()` 或 `createAgentController()` 前解析 workspaceRoot 后读取 active threadId。
  - 创建 `CodexAgentAdapter` 时传入 `resumeThreadId`。
  - 每次 `handleAgentInteraction()` 成功返回后，读取 `orchestrator.getThreadId()` 并写回。
  - `/reset`（或 `codex.reset`）执行时，清空当前 workspace 的 active threadId。
- 验证：
  - 单元测试（如可行）：模拟写入 threadId 后启动流程应使用该 threadId；reset 后不再使用。
  - 手测：先在 TG/Web 建立对话，再启动 CLI 继续。

### T3: 统一 SessionManager 的“workspace 切换”语义
- 文件：`src/telegram/utils/sessionManager.ts`
- 改动点：
  - 在 `getOrCreate(userId, cwd)` 中：
    - 计算 `workspaceRoot = detectWorkspace()`（需要临时切换 `process.cwd()` 或提供 `detectWorkspaceFromPath(cwd)`；优先改 detector 支持传入 startDir）。
    - 若 existing session 存在且 workspaceRoot 改变：重建 orchestrator（带 resumeThreadId=目标 workspace active thread）。
  - 在 `setUserCwd()`：若 workspaceRoot 变化，触发上述切换逻辑，而不是仅 `setWorkingDirectory()`。
  - 保留用户模型（model）与代理选择。
- 验证：
  - 手测：在 TG/Web `/cd` 到另一个 workspace，确认对话 thread 跟随 workspace 切换。

### T4: Telegram：默认按 workspace 恢复；/resume 与 /reset 对齐
- 文件：`src/telegram/bot.ts`、`src/telegram/adapters/codex.ts`
- 改动点：
  - 自动恢复逻辑改为：只要当前 workspace 有 active threadId，就恢复（而不是“按用户保存 thread”）。
  - `/resume`：强制重建 session 并从 workspace active thread 恢复。
  - `/reset`：清空 workspace active threadId 并重置 session。
- 验证：
  - 手测：CLI 建对话 → TG 继续 → TG /reset → CLI 再发消息应进入新 thread。

### T5: Web：按 workspace 恢复；/cd 切换 workspace 不重置为新 thread
- 文件：`src/web/server.ts`
- 改动点：
  - 创建/重建 orchestrator 时，读取当前 cwd 对应 workspace 的 active threadId。
  - `/cd` 成功后：重新获取 orchestrator（目标 workspace 的 active thread）。
  - 每次 prompt 完成后写回 `threadId` 为 active。
- 验证：
  - 手测：打开 Web 不发消息不应触发模型调用；发消息后 CLI/TG 可继续。

### T6: 修复/扩展 Workspace 探测：支持从任意路径计算 workspaceRoot
- 文件：`src/workspace/detector.ts`
- 改动点：
  - 提供 `detectWorkspaceFrom(startDir: string): string`，复用现有 marker 查找逻辑。
  - 保留现有 `detectWorkspace()` 行为不变（默认从 `process.cwd()`）。
- 验证：
  - 单元测试：给定不同 startDir 能找到最近 `.ads/workspace.json`。

## Validation Checklist
- `npm test`
- 若修改到 Web 前端相关代码：`npm run build`
- 手动回归：
  - CLI→TG→Web 同一 workspace 连续对话
  - Web/TG `/cd` 切换 workspace 后 thread 不串
  - `/reset` 后三端都进入新 thread

## Risks
- 多端并发在同一 thread 同时发消息可能导致上下文交错（本期不做串行锁）。
- 旧的 per-user/per-session thread 存储仍存在，需避免与新逻辑冲突。
