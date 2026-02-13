# Workspace Session Sync（CLI/Web/Telegram）- 设计文档

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 与需求一致 |
| Status | Draft |  |
| Authors | Codex |  |
| Stakeholders | CLI / Web / Telegram |  |
| Created | 2025-12-16 |  |
| Last Updated | 2025-12-16 |  |
| Related Requirements | 01-req.md | requirement v1 |
| Related Implementation Plan | 待补充 |  |

## 2. Context

### 2.1 Problem Statement
- 同一台机器上会同时使用 CLI、Telegram bot、Web console。
- 现状是不同入口各自维护 threadId（甚至 CLI 不持久化），导致“在家用 CLI、路上用 TG、办公用 Web”无法无缝继续同一段对话。
- Telegram/Web 的 `/cd` 目前会导致会话 thread 被重置为新 thread（失去上下文），不符合“按 workspace 继续”的预期。

### 2.2 Goals
- 以 workspace 为粒度：每个 workspace 只有一个 active threadId。
- CLI/Web/Telegram 三端统一：在同一 workspace 下自动恢复并继续该 active thread。
- `/cd` 切换 workspace 时：切换到目标 workspace 的 active thread（存在则恢复，不存在则新建并写回）。
- 仅打开 Web 页面/建立 WS 连接不触发模型调用（不产生 token 消耗）。
- 不改动数据库 schema（复用现有 `.ads/state.db` 表）。

### 2.3 Non-Goals
- 多用户隔离（例如多个 Telegram 用户共用同一 bot）。
- 多会话管理（同一 workspace 维护多个命名会话/可选会话列表）。
- 跨机器同步。
- 记忆检索/RAG。

## 3. Current State

### 3.1 Thread 恢复机制
- Codex SDK 支持通过 `resumeThreadId` 恢复远端 thread。
- 该机制不是“把历史注入 prompt”，而是“继续同一个远端 thread”。

### 3.2 现有实现差异
- CLI：创建 `CodexAgentAdapter` 时未传入 `resumeThreadId`，重启 CLI 通常进入新 thread。
- Telegram：`ThreadStorage`（`thread_state`）按用户保存 threadId，并通过 `/resume` 或“无活跃 session 时自动恢复”继续对话；与 CLI/Web 不共享。
- Web：按 session/token 派生 userId 保存 threadId；与 CLI/Telegram 不共享。
- `/cd`：Telegram/Web 通过 `orchestrator.setWorkingDirectory()` 切换目录，会触发 Codex session reset，后续会启动新 thread。

## 4. Target State Overview

### 4.1 核心方案
- 定义：每个 workspace 有且仅有一个 active threadId。
- 存储：将 active threadId 存入该 workspace 的 `.ads/state.db` 的 `kv_state`（无需 schema 变更）。
- 行为：
  - 三端创建会话时：优先从 workspace 读取 active threadId，并作为 `resumeThreadId`。
  - 每次对话完成后：读取当前 `threadId`，写回为该 workspace 的 active threadId。
  - Reset：清空该 workspace 的 active threadId 并重置本地 orchestrator。
  - `/cd`：切换到目标 workspace，并按目标 workspace 的 active threadId 重新创建 orchestrator（而不是仅 setWorkingDirectory）。

### 4.2 为什么不会浪费 token
- “恢复 threadId”只是本地设置 `resumeThreadId`；只有真正发送 prompt（触发 `runCollaborativeTurn` / `session.send()`）才会调用模型并产生 token。

## 5. Detailed Design

### 5.1 数据模型（复用现有表）
目标表：`kv_state(namespace, key, value, updated_at)`（已存在于 `.ads/state.db`）。

约定：
- namespace：`workspace_session`
- key：`active_thread_id`
- value：`<threadId>`（字符串）

说明：由于使用“每个 workspace 自己的 state.db”，无需把 workspaceRoot 编码进 key。

### 5.2 新增组件：WorkspaceSessionStore
新增一个轻量存储模块，职责：
- 给定 `workspaceRoot`（即包含 `.ads/workspace.json` 的目录）
- 读写该 workspace 的 `.ads/state.db`
- 提供 `getActiveThreadId / setActiveThreadId / clearActiveThreadId`

### 5.3 SessionManager 行为调整（Web/Telegram 共用）
目标：当 cwd/workspace 变化时，不再仅 setWorkingDirectory（会导致新 thread），而是“切换 workspace session”。

设计要点：
- 为每个 userId 的 SessionRecord 增加 `workspaceRoot` 概念（在本项目中等同于传入 cwd）。
- 当 `getOrCreate(userId, cwd)` 发现 cwd 与 record.cwd 不同：
  - 关闭/替换旧 orchestrator（保留必要状态，如 model 设置）
  - 从目标 workspace 的 WorkspaceSessionStore 读取 active threadId
  - 用 `resumeThreadId=activeThreadId` 创建新 orchestrator
- 每次对话完成后：从 orchestrator 读取 `threadId` 并写回到目标 workspace。

### 5.4 Telegram 交互调整
- 默认自动恢复：不再依赖“按用户保存的 threadId”才能恢复；而是始终按当前 workspace 恢复。
- `/resume`：保留为“强制重新加载当前 workspace 的 active thread”用于排障。
- `/reset`：清空当前 workspace 的 active threadId，并重置本地 orchestrator。

### 5.5 Web 交互调整
- 连接时：只建立 WS 与本地状态恢复，不触发模型调用。
- 发送 prompt 时：使用当前 workspace 的 active thread。
- `/cd`：切换 workspace 后，切换到目标 workspace 的 active thread。

### 5.6 CLI 调整
- CLI 启动：读取当前 workspace 的 active threadId，传入 `CodexAgentAdapter(resumeThreadId=...)`。
- CLI 每次完成一次 agent 交互：如果拿到 `threadId`，写回为 active。
- CLI `/reset`：除了重置 orchestrator，还需清空当前 workspace 的 active threadId。

## 6. Alternatives & Decision Log
| 选项 | 描述 | 优势 | 劣势 | 决策 |
| ---- | ---- | ---- | ---- | ---- |
| A | 继续沿用各入口各自 threadId（现状） | 无改动 | 无法跨端衔接 | Rejected |
| B | 全部写入 ADS 根目录的单一 state.db，并用 workspaceRoot 当 key | 便于集中管理 | CLI 若在别的 workspace 启动，不易共享 | Rejected |
| C | 每个 workspace 自己的 `.ads/state.db` 存 `active_thread_id` | 与 CLI 启动位置天然一致；按 workspace 自包含 | 假设同一机器可访问各 workspace | Accepted |

## 7. Risks & Mitigations
- 多端并发：同一 thread 同时被多个端发送消息，可能导致对话上下文交错。
  - 缓解：保持默认单用户使用；如需严格串行，可在实现阶段增加“busy 锁/队列”（本期不做）。
- thread 失效/损坏：远端 thread 可能不可恢复或被判定损坏。
  - 缓解：沿用现有 reset/错误提示逻辑；允许 `/reset` 清空 active thread。
- 多用户 Telegram：若多个 Telegram 用户使用同一 bot，会共享 workspace thread，可能混淆。
  - 缓解：需求明确为单用户场景；如未来支持多用户需引入 user scope。

## 8. Testing & Validation
- 场景 1：在 CLI 发送消息 → 用 Telegram 继续同一话题 → 用 Web 继续，确认上下文衔接。
- 场景 2：Telegram `/cd` 切换到另一个已初始化 workspace → 发送消息 → 再切回原 workspace，确认各自 thread 不串。
- 场景 3：执行 `/reset`（Telegram 或 CLI）后，从其他端继续发消息应进入新 thread。
- 场景 4：仅打开 Web 页面不发消息，不应触发模型调用（可用日志侧面验证）。

## 9. Release & Rollback
- 发布：按 implementation.md 的任务拆分逐步合并；Web/Telegram/CLI 同步更新。
- 回滚：保留旧逻辑（各入口自管理 threadId），或在实现中保留一个开关以快速禁用（是否需要由 implementation.md 决定）。
