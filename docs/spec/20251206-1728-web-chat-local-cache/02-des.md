---
id: des_vcf3dg2t
type: design
title: Web chat local cache - 设计
status: finalized
created_at: 2025-12-06T09:28:40.744Z
updated_at: 2025-12-06T02:18:16.000Z
---

# Web chat local cache - 设计

# Web 本地聊天缓存 - 设计文档

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | |
| Status | Draft | |
| Authors | Codex | |
| Stakeholders | Web 前端 / 后端 | |
| Created | 2025-12-06 | |
| Last Updated | 2025-12-06 | |
| Related Requirements | docs/spec/20251206-1728-web-chat-local-cache/01-req.md | |
| Related Implementation Plan | TBD | |

## 2. Context
### 2.1 Problem Statement
- 刷新/意外关闭会丢失当前聊天展示；后端仅有 threadId，不回放消息。

### 2.2 Goals
- 本地存储最近一段聊天记录，刷新后恢复 UI，限制条数/大小；按 token 隔离；可清空。

### 2.3 Non-Goals / Out of Scope
- 不做跨设备/多端同步；不缓存附件文件；不做本地加密。

## 3. Current State
- Web 前端为纯前端渲染，消息保存在内存 DOM，刷新即丢失；后端保存 threadId 但不返回历史。

## 4. Target State Overview
- 方案：前端用 localStorage 缓存最近 N 条消息（文本/角色/时间/简要状态），限制总大小与条数；按 token 生成缓存 key；加载时恢复并渲染；提供清空入口。
- 收益：刷新不丢记录，体验改善；无需后端改造。
- 风险：存储膨胀/损坏；明文存储。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | 发送/接收消息后写入缓存；页面加载时读缓存→渲染；清空入口删除缓存。 |
| 控制流 | 发送/接收→调用 `appendToCache`；启动→`loadCache`（检查过期并裁剪）；“清空”按钮/菜单→`clearCache`。 |
| 并发/容错 | 单线程 localStorage；异常/JSON 解析失败则忽略并清空缓存。 |
| 可扩展性 | 未来可替换为 IndexedDB 或后端同步；接口封装在前端脚本内部。 |

### 5.1 Flow (简化)
```
load -> read localStorage by key (token-scoped) -> render messages
on new message (user/ai/status) -> push to cache -> trim by count/size -> persist
on clear -> remove key -> clear UI
```

## 6. Components & Interfaces

### Component W-Cache
- 责任：管理本地缓存的读/写/裁剪/清空。
- 输入：消息对象 `{role:'user'|'ai'|'status', text, ts, kind?}`，token。
- 输出：缓存数组存入 localStorage。
- 关键接口：`loadCache(token)`, `append(message, token)`, `clear(token)`, `trim(limitCount, limitBytes)`.
- 影响面：仅前端脚本内聚。

### Component W-UI Hook
- 责任：在现有消息渲染路径调用缓存接口；提供“清空历史”入口。
- 输入：现有消息流回调、清空按钮事件。
- 输出：更新 DOM & 缓存。
- 影响面：`src/web/server.ts` 内嵌脚本。

## 7. Data & Schemas
- 缓存结构（JSON 数组）：
```json
[
  {"r":"user","t":"hi","ts":1700000000000},
  {"r":"ai","t":"hello","ts":1700000001000}
]
```
- 字段：`r`=role，`t`=text（纯文本，已过滤），`ts`=毫秒时间戳，`k` 可选消息类型（status 等）。
- 命名约定：`chat-cache::<token-prefix>`，token 空时用 `"default"`。
- 附件：不存；如需提示，可存占位文本。

## 8. Operational Considerations
### 8.1 Error Handling & Fallbacks
- 解析失败：捕获异常，清空缓存并继续正常会话。
- 超限：超过条数或字节数时丢弃最旧记录。
- 过期：加载时检查过期时间（默认 7 天，可配置）；过期则清空不渲染。
- 清空：提供 UI 入口调用 `clear`，并刷新显示。

### 8.2 Observability
- 控制台日志（debug 级别）：缓存加载条数、裁剪动作、清空动作（可开关）。
- 无后端指标。

### 8.3 Security & Compliance
- 明文本地存储，仅按 token 隔离；不存敏感字段；可一键清空。

## 9. Testing Strategy
- 用例：
  - 发送/接收多条消息后刷新，历史能恢复，顺序/角色正确。
  - 超过上限时最旧消息被裁剪。
  - 超过过期时间（默认 7 天）后加载，缓存自动清空不渲染。
  - 缓存损坏（手动修改 localStorage）时不影响新消息，并自动清空。
  - 清空按钮后缓存与 UI 同时清空。
  - 不同 token 时缓存不串。

## 10. Release & Rollback
- 发布：前端改动上线即生效。
- 回滚：移除缓存读写调用，删除相关代码块。
- 数据保护：{data_protection}
- 合规要求：{compliance_requirements}

### 9.4 Performance & Capacity
- 目标指标：{performance_targets}
- 负载预估：{capacity_assumptions}
- 优化手段：{optimization_strategies}

## 10. Testing & Validation Strategy
> 定义验证计划，确保设计目标在交付时被验证。
| 测试类型 | 目标 | 关键场景 | 负责人 |
| -------- | ---- | -------- | ------ |
| 单元测试 | {unit_goal} | {unit_cases} | {owner} |
| 集成测试 | {integration_goal} | {integration_cases} | {owner} |
| 端到端 | {e2e_goal} | {e2e_cases} | {owner} |
| 数据验证 | {data_goal} | {data_checks} | {owner} |

## 11. Alternatives & Decision Log
> 记录考虑过的方案及决策依据，便于后续回溯。
| 选项 | 描述 | 优势 | 劣势 | 决策 |
| ---- | ---- | ---- | ---- | ---- |
| {option_a} | {summary} | {pros} | {cons} | Accepted / Rejected |

## 12. Risks & Mitigations
> 梳理潜在风险与应对措施，支撑风险管理。
| 风险 | 影响 | 概率 | 缓解措施 |
| ---- | ---- | ---- | -------- |
| {risk_item} | {impact} | {likelihood} | {mitigation} |

## 13. Assumptions & Dependencies
> 列出关键假设及外部依赖，确保各方认知一致。
- 假设：{assumption}
- 依赖：{dependency}
- 触发条件：{trigger}

## 14. Implementation Notes (高层次)
> 给出实施的概览安排，为实施计划提供输入。
- 阶段划分：{phase_summary}
- 关键里程碑：{milestones}
- 回滚策略：{rollback_plan}
- 验证完成标准：{definition_of_done}

## 15. Appendix (可选)
> 归档支持材料或扩展信息，便于查阅。
- 参考链接：{references}
- 术语表：{glossary}
- 其他补充材料：{appendices}
