---
id: req_qcbj590z
type: requirement
title: Web chat local cache - 需求
status: finalized
created_at: 2025-12-06T09:28:40.740Z
updated_at: 2025-12-06T01:31:40.000Z
---

# Web chat local cache - 需求

# Web 本地聊天缓存 - 需求说明

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | Draft |
| Status | Draft | 需求讨论中 |
| Owner | Codex | |
| Created | 2025-12-06 | |
| Updated | 2025-12-06 | |
| Related Design | TBD | |
| Related Plan | TBD | |

## Introduction
- 问题背景：Web 控制台刷新或意外关闭会丢失当前聊天展示，用户需要重新滚动查看历史，体验不佳。
- 根因摘要：前端未做本地持久化；后端虽保存 threadId，但不回放消息。
- 期望成果：在本地保存最近一段聊天记录，刷新后自动恢复展示，不影响后端上下文；限制长度/大小，避免存储膨胀。

## Scope
- In Scope：
  - 前端使用浏览器本地存储（localStorage 或同等级）缓存聊天记录（仅文本消息/状态），无需后端改造。
  - 缓存生命周期：限定条数/大小，过旧记录自动裁剪；按 token（客户端身份）隔离，避免串会话。
  - 刷新/重开页面后自动恢复最近记录，并可继续正常收发消息。
  - 提示与开关：可提供开关或清除入口（例如“清空历史”），防止用户无法手动清理。
- Out of Scope：
  - 跨设备/多端同步（不做服务器端消息回放）。
  - 缓存二进制图片/文件（如有附件，仅存元数据或忽略）。
  - 加密存储（默认明文存本地，如需加密另行需求）。

## Functional Requirements

### Requirement 1: 本地缓存与恢复
- 概述：将最近 N 条聊天消息存入本地存储，限制总大小/条数；刷新后加载缓存并恢复到 UI。

**User Story:** 作为 Web 用户，我希望刷新页面后仍能看到最近的聊天记录，以便不中断阅读和继续操作。

#### Acceptance Criteria
- [ ] WHEN 有新消息（用户或 AI）追加， THEN 将其写入本地缓存，并保持总条数不超过上限（如 100 条）和总大小不超过上限（如 200KB），超出则从最旧开始裁剪。
- [ ] WHEN 页面重新加载， THEN 自动读取本地缓存并渲染到聊天窗口，保持原有顺序和角色标记。
- [ ] WHEN 缓存为空或损坏， THEN 正常显示空对话，不阻塞新消息收发。
- [ ] WHEN 用户点击“清空历史”（或等效入口）， THEN 本地缓存被清除，UI 也清空。

### Requirement 2: 安全与隔离
- 概述：缓存仅在本机、当前 token 下可见，不跨用户/跨 token。

**User Story:** 作为 Web 用户，我希望缓存只对当前会话可见，避免多用户/多 token 串用。

#### Acceptance Criteria
- [ ] WHEN 生成缓存 key， THEN 需包含 token（或等效客户端标识）前缀，避免不同 token 互相读取。
- [ ] WHEN 切换 token 或清空 token， THEN 需清除或忽略原有缓存，避免串会话。
- [ ] WHEN 写入缓存， THEN 不应包含敏感信息（不存 API key 等），只存聊天文本/角色/时间等必要字段。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 性能 | 缓存读写不阻塞主线程 | 操作在 16ms 以内 | 手动/性能观测 |
| 存储 | 限制条数与总大小 | 默认 ≤100 条，≤200KB（可配置） | 手动检查/调试日志 |

## Observability & Alerting
- 前端可选：在 console 记录缓存裁剪/恢复情况，便于调试。
- 不新增后端指标/告警。

## Compliance & Security
- 仅存本地，明文存储；默认不缓存附件内容。
- 用户可手动清空；切换 token/会话时清理或隔离。

## Release & Timeline
- 关键里程碑：需求 → 设计 → 实施 → 验证。
- 回滚：移除本地缓存读写逻辑，即恢复现状。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-06 | 初稿 | Codex |
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
