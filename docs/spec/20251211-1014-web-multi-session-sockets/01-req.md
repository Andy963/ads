---
id: req_txptdm04
type: requirement
title: Web multi-session sockets - 需求
status: finalized
created_at: 2025-12-11T02:14:09.665Z
updated_at: 2025-12-10T18:23:28.000Z
---

# Web multi-session sockets - 需求

# Web 多会话并行 WS 支持 - 需求文档

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | 需求阶段 |
| Owner | Codex |  |
| Created | 2025-12-11 |  |
| Updated | 2025-12-11 |  |
| Related Design | 待补充 |  |
| Related Plan | 待补充 |  |

## Introduction
- 问题背景：Web 控制台切换会话标签时会关闭当前 WebSocket 并重连目标会话，导致先前会话的连接被中断，用户感知为“刷新/清空”。
- 根因摘要：`switchSession` 会强制关闭现有 WS；服务器端 `MAX_CLIENTS` 保护按全局连接数替换最早连接，未支持同一浏览器内的并行多会话。
- 期望成果：在 ADS_WEB_MAX_CLIENTS 环境限制下，允许会话并行保持各自的 WS 连接与聊天上下文，切换标签不再中断已打开会话。

## Scope
- In Scope：Web 前端会话标签的 WS 连接管理、状态恢复与 UI 提示；服务器端连接上限策略与并行会话兼容性。
- Out of Scope：移动端/Telegram、非 Web 客户端的会话并发行为；与会话内容的跨浏览器持久化（仍沿用现有缓存策略）。

## Functional Requirements

### Requirement 1: 会话标签保持独立 WS 连接
- 概述：每个已打开的会话标签维持自己的 WS；切换标签不关闭其它会话的 WS。

**User Story:** 作为 Web 控制台用户，我希望在多个会话间切换时保持各自在线，以便不丢失上下文或中断任务。

#### Acceptance Criteria
- [ ] WHEN 切换至另一会话标签 THEN 原会话 WS 不被关闭，返回原标签时连接仍保持（或按健康状态自动重连）并保留历史 UI。
- [ ] WHEN 某会话 WS 断开 THEN 仅影响该会话标签，其他会话可继续收发消息。
- [ ] IF 会话标签已存在活跃 WS THEN 重复切换时应复用该连接，不重复建立。

#### Validation Notes
- 日志 / 监控：前端控制台日志记录每个会话的 WS 状态变更（open/close/error）含 sessionId。
- 手动验证步骤：打开两个会话标签，各自发送消息，切换往返确认双方连接持续且消息可达。

### Requirement 2: 上限与资源保护
- 概述：并行会话应遵守 ADS_WEB_MAX_CLIENTS（环境可配置），超出限制需明确提示且不意外踢掉现有会话。

**User Story:** 作为用户，我希望在并行上限内稳定使用，不被静默替换掉当前会话。

#### Acceptance Criteria
- [ ] WHEN 尝试建立超过 ADS_WEB_MAX_CLIENTS 的 WS 连接 THEN 前端提示已达上限，不应无提示地关闭其他活跃会话。
- [ ] WHEN 达到上限后关闭某会话 WS THEN 释放名额后可再新建其他会话连接。
- [ ] IF 服务端返回 4409/其他限流状态 THEN 前端在对应会话显示原因且保持 UI 可重试。

#### Validation Notes
- 日志 / 监控：前端状态提示含服务器关闭码；可在浏览器控制台看到对应 sessionId 与关闭原因。
- 手动验证步骤：在 ADS_WEB_MAX_CLIENTS=环境值 下打开比上限多 1 个会话，确认提示并不影响已在上限内的会话，再关闭一个后可成功连入。

### Requirement 3: 会话状态保持与恢复
- 概述：每个会话的聊天记录、计划与输入草稿在多会话并行时继续按会话隔离存储，切换不丢失。

**User Story:** 作为用户，我希望回到任意会话时看到上次的对话与草稿，便于继续工作。

#### Acceptance Criteria
- [ ] WHEN 多会话并行存在 THEN 各自的聊天记录与计划显示与切换前一致，切换不清空。
- [ ] WHEN 某会话重连后 THEN 能恢复缓存的消息/计划，若无缓存则给出空状态提示。

#### Validation Notes
- 日志 / 监控：无新增要求，沿用现有 sessionStorage 缓存并在控制台输出恢复结果。
- 手动验证步骤：在两会话中分别输入草稿与发送消息，切换并刷新确认状态恢复正常。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 性能 | 并行 2 个 WS 时前端无明显卡顿，消息发送延迟无显著增加 | 手动主观评估 | 手测 |
| 可靠性 | 单个会话 WS 异常不影响其他会话 | 分会话错误隔离 | 手测 |

## Observability & Alerting
- 日志：前端 console 输出 WS 状态（open/close/error）带 sessionId；服务端保留连接事件日志。
- 指标 / Dashboard：暂无新增。
- 告警：不新增告警。

## Compliance & Security
- 权限：无新增权限变更。
- 数据保护 / 合规：维持现有本地缓存策略（sessionStorage），不跨用户存储。

## Release & Timeline
- 关键里程碑：需求确认 → 设计 → 实施计划 → 开发与测试。
- 验收窗口：设计/实施计划评审通过后交付。
- 回滚方案：可恢复为单连接模式（切换时关闭旧 WS）。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-11 | 初版需求 | Codex |
