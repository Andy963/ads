---
id: req_7gfumi87
type: requirement
title: Workspace Session Sync /exit - 需求
status: finalized
created_at: 2025-12-16T12:22:12.330Z
updated_at: 2025-12-16T04:34:28.000Z
---

# Workspace Session Sync /exit - 需求

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

# Workspace Session Sync（CLI/Web/Telegram）- 需求文档

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | 需求阶段 |
| Owner | Codex |  |
| Created | 2025-12-16 |  |
| Updated | 2025-12-16 |  |
| Related Design | 待补充 |  |
| Related Plan | 待补充 |  |

## Introduction
- 问题背景：同一台机器上同时使用 CLI、Telegram bot、Web console 时，各入口会各自创建/恢复会话（Codex thread）与本地历史，导致对话上下文无法在不同入口间无缝衔接。
- 根因摘要：当前 threadId/历史持久化是“按入口/按 session”隔离存储，缺少“按 workspace 绑定的单一 active thread”机制。
- 期望成果：以 workspace 为粒度，三端共享同一条 Codex thread；在家用 CLI、路上用 TG、办公用 Web 时可继续同一段对话。

## Scope
- In Scope：
  - 为每个 workspace 维护 1 个 active threadId（可恢复的 Codex thread）。
  - CLI/Web/Telegram 三端统一：创建会话时优先恢复该 workspace 的 active thread。
  - 切换 workspace（例如 Telegram/Web 的 `/cd`）不再“丢上下文重开”，而是切换到目标 workspace 的 active thread。
  - 不引入向量检索/embedding；不做 DB schema 变更（复用现有 `.ads/state.db` 结构）。
- Out of Scope：
  - 多用户隔离、多人共享同一 bot 的权限体系。
  - 一个 workspace 多条 thread 的管理/版本化（命名会话、多分支会话）。
  - 跨机器同步（不同机器共享 threadId/状态）。
  - 复杂的“记忆检索注入”（RAG/FTS5/摘要等）。

## Functional Requirements

### Requirement 1: workspace 级 active thread 存取
- 概述：为每个 workspaceRoot 持久化存取一个 active threadId。

**User Story:** 作为单人开发者，我希望同一个 workspace 的对话 thread 可被恢复，以便在不同入口继续同一上下文。

#### Acceptance Criteria
- [ ] 系统能够根据 workspaceRoot 读取/写入该 workspace 的 active threadId。
- [ ] 当一次对话成功完成且获取到 threadId 时，系统会将其写入为该 workspace 的 active threadId（幂等更新）。
- [ ] 不允许通过覆盖/删除数据库文件来实现本功能（仅允许更新现有 state.db 内容）。

#### Validation Notes
- 手动验证：在任一入口发起对话后，确认本地存储中出现该 workspace 的 active threadId；再次进入同 workspace 时能复用。

### Requirement 2: CLI 恢复 workspace active thread
- 概述：CLI 启动时，若存在 workspace 的 active threadId，则用其作为 `resumeThreadId` 创建 Codex 会话。

**User Story:** 作为 CLI 用户，我希望关闭终端后再次打开仍能继续之前的对话，以便不中断工作流。

#### Acceptance Criteria
- [ ] WHEN 在 workspace 中启动 CLI THEN 若存在 active threadId，CLI 的 Codex 会话应恢复该 thread。
- [ ] WHEN active threadId 不存在 THEN 按现有逻辑创建新 thread，并在首次可用时写回为 active。

#### Validation Notes
- 手动验证：先用 TG/Web 建立对话，再在同 workspace 启动 CLI，发送一句“继续刚才的话题”，模型应能接续。

### Requirement 3: Telegram 自动继续 workspace active thread
- 概述：Telegram 默认行为与其他端一致：自动继续 workspace 的 active thread，而不是需要手动 `/resume`。

**User Story:** 作为 Telegram 用户，我希望随时打开手机继续同一段对话，无需额外命令。

#### Acceptance Criteria
- [ ] WHEN Telegram 收到用户消息且当前 workspace 有 active threadId THEN 自动恢复该 thread 并继续对话。
- [ ] WHEN 用户通过 `/cd` 切换到另一个 workspace THEN Telegram 会话应切换到目标 workspace 的 active thread（如存在）。
- [ ] `/resume` 保留但语义调整为“强制重新加载当前 workspace 的 active thread”（用于排障），不再是必须步骤。

#### Validation Notes
- 手动验证：在 CLI 建立对话后，用 Telegram 继续同一话题；再 `/cd` 到另一个 workspace，确认 thread 不串。

### Requirement 4: Web 端按 workspace 自动恢复，连接不消耗 token
- 概述：Web 建立连接时只加载本地状态，不触发模型调用；用户真正发起 prompt 时才产生 token。

**User Story:** 作为 Web 用户，我希望打开网页不会产生 token 消耗，同时在同一 workspace 自动继续。

#### Acceptance Criteria
- [ ] WHEN WebSocket 客户端连接 THEN 不应自动发送任何 prompt 到模型（仅准备会话/恢复 threadId）。
- [ ] WHEN 用户发送 prompt THEN 使用该 workspace 的 active threadId 恢复并继续对话。
- [ ] WHEN Web `/cd` 切换 workspace THEN 会话切换到目标 workspace 的 active thread（如存在）。

#### Validation Notes
- 手动验证：仅打开 Web 页面不发送消息，确认无模型调用；发送消息后再在 CLI/TG 继续。

### Requirement 5: Reset/切换一致性
- 概述：当用户显式重置会话时，应能让该 workspace 的 active thread 进入新的对话（避免“重置后又回到旧 thread”）。

**User Story:** 作为用户，我希望在任一入口重置对话后，其他入口也能跟随进入新对话。

#### Acceptance Criteria
- [ ] WHEN 用户在任一入口执行“重置会话” THEN 当前 workspace 的 active threadId 应被清空或替换为新 thread（以产品定义为准）。
- [ ] IF 未提供 Web 端重置命令 THEN 至少保证 Telegram/CLI 的重置行为不会在下一条消息又恢复旧 thread。

#### Validation Notes
- 手动验证：在 Telegram 执行重置后，用 CLI 继续发消息应进入新 thread（不再具备旧上下文）。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 性能 | 仅打开 Web/TG 不应触发模型调用 | 0 次模型调用 | 手测/日志 |
| 可靠性 | threadId 持久化失败不应导致程序崩溃 | 降级为新 thread | 手测 |
| 可维护性 | 共享逻辑在三端复用，避免分叉实现 | 代码复用 | 代码评审 |

## Observability
- 日志：记录“恢复/更新 active threadId”的事件，输出 threadId 前 8 位与 workspaceRoot。
- 排障：可通过保留的 `/resume`（TG）或新增轻量 debug 输出（CLI/Web）确认当前是否使用了恢复 thread。

## Compliance & Security
- 单用户场景：默认不实现多用户隔离；仍需避免在日志中泄露敏感 token。
- 数据保护：不删除/覆盖任何数据库文件，仅更新 state.db 内记录。

## Release & Timeline
- 里程碑：需求确认 → 设计 → 实施计划 → 开发与测试 → /ads.review。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-16 | 初版需求 | Codex |
> 明确本次需求的边界，避免范围蔓延。
- In Scope：{in_scope_items}
- Out of Scope：{out_scope_items}

## Functional Requirements

### Requirement {id}: {title}
- 概述：{requirement_description}

**User Story:** 作为 {角色}，我希望 {动机}，以便 {价值}。

#### Acceptance Criteria
> 使用复选框列出可验证条件，确保覆盖主流程、异常流程及边界情况。
- [ ] WHEN {condition_1} THEN {expected_result_1}（验证方式：{validation_method_1}）
- [ ] WHEN {condition_2} THEN {expected_result_2}
- [ ] IF {special_condition} THEN {special_result}
> 按需增删条目，可继续添加复选项。

#### Validation Notes
> 总结验证方式，确保上线前检查齐全。
- 日志 / 监控：{logging_or_metrics}
- 手动验证步骤：{manual_validation}

---

## Non-Functional Requirements (Optional)
> 描述性能、安全、可靠性等非功能目标，可按类型扩充。
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| {category} | {description} | {metric} | {validation} |

## Observability & Alerting
> 说明系统可观测性要求，便于上线后监控运行状况。
- 日志：{logging_requirements}
- 指标 / Dashboard：{metrics_requirements}
- 告警：{alerting_policy}

## Compliance & Security (If Needed)
> 若涉及敏感数据或合规要求，在此明确。
- 权限：{permission_changes}
- 数据保护 / 合规：{compliance_requirements}

## Release & Timeline
> 给出交付节奏、验收窗口与回滚方案，方便项目排期。
- 关键里程碑：{milestones}
- 验收窗口：{acceptance_window}
- 回滚方案（可选）：{rollback_plan}

## Change Log
> 记录文档的演进历程，确保修改可追踪。
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| {version_entry} | {date_entry} | {change_description} | {author_entry} |
