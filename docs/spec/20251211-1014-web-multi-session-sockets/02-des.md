---
id: des_8qtephbn
type: design
title: Web multi-session sockets - 设计
status: finalized
created_at: 2025-12-11T02:14:09.671Z
updated_at: 2025-12-10T18:29:54.000Z
---

# Web multi-session sockets - 设计

# Web 多会话并行 WS 支持 - 设计文档

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 与需求一致 |
| Status | Draft |  |
| Authors | Codex |  |
| Stakeholders | Web/Infra |  |
| Created | 2025-12-11 |  |
| Last Updated | 2025-12-11 |  |
| Related Requirements | 01-req.md |  |
| Related Implementation Plan | 待补充 |  |

## 2. Context
### 2.1 Problem Statement
- 切换会话标签会关闭当前 WS 并重连目标会话，导致原会话被中断，用户认为“刷新/清空”。
- 服务器按 MAX_CLIENTS 静默踢掉最早连接，前端无清晰提示。

### 2.2 Goals
- 每个会话标签维持独立 WS，切换不关闭其他连接，并在 ADS_WEB_MAX_CLIENTS 上限内并行。
- 超限时前端提示原因，不静默踢掉活跃会话；释放名额后可重连。
- 保持各会话缓存（聊天/计划/草稿）隔离与可恢复。

### 2.3 Non-Goals
- 不做跨浏览器/跨设备持久化（仍用 sessionStorage）。
- 不改动 Telegram/CLI 行为。

## 3. Current State
- 前端：全局单 WS；`switchSession` 关闭当前 WS 并对新会话重连；状态存于 sessionViews + sessionStorage。
- 服务端：`MAX_CLIENTS` 超限时踢掉最早连接（无前端提示），不按 session/token 区分。
- 痛点：切换即断线；超限静默；多会话隔离依赖单 WS，缺少 per-session 重连。

## 4. Target State Overview
- 方案：前端维护 per-session WS map；切换标签复用对应连接，不关闭其他；每个会话独立重连/状态。服务端超限时返回关闭码/消息，前端关联会话展示。
- 收益：会话不中断，错误隔离；超限可感知。
- 风险：多 WS 增加资源占用；需避免消息路由混淆。

### 4.1 Architecture Diagram
```
UI tabs -> SessionConnectionManager (per session WS)
          WS_n <-> Server (enforces MAX_CLIENTS, returns close codes)
```

### 4.2 Deployment / Topology
- 环境：ADS_WEB_MAX_CLIENTS 由 env 配置。
- 节点：浏览器 ↔ WebSocket Server ↔ Agent/Workspace。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | 文本/图片消息按会话 ID 通过对应 WS 发送；返回流量写入该会话视图与缓存。 |
| 控制流 | 切换标签仅切换活跃视图；不触发其他 WS 关闭；必要时懒加载/重连目标会话 WS。 |
| 并发/容错 | 每会话独立重连与 busy 状态；某会话断线不影响其他。 |
| 可扩展性 | WS 上限受 ADS_WEB_MAX_CLIENTS，前端在超限时降级提示；后续可按 token/会话粒度做更细限流。 |

### 5.1 Sequence (简)
1) 用户切换到会话 B；若无连接则建立 WS(B)，否则复用；WS(A) 保持。
2) 若服务器因超限拒绝 WS(B)，前端提示“已达上限: <code>”并保持 A 不变。
3) 会话 B 重连时仅更新自身 UI/缓存。

## 6. Components & Interfaces
### Component A: SessionConnectionManager（前端新增抽象）
- 责任：维护 sessionId → WebSocket 实例；提供 send/close/reconnect 钩子；暴露状态事件。
- 输入：sessionId、url、token；用户消息/命令。
- 输出：WS 状态（open/close/error/code）、消息流。
- 依赖：浏览器 WebSocket、现有 UI 状态存储。
- 影响面：替换全局单 WS；`switchSession` 不再关闭其他连接。

### Component B: Session View State
- 责任：继续隔离消息/计划/草稿缓存；绑定对应 WS 状态。
- 输入：WS 消息、用户输入、计划更新。
- 输出：渲染和本地缓存。

### Component C: Server Connection Policy
- 责任：超限策略返回明确关闭码/消息；避免静默踢已有连接（或改为拒绝新建并附理由）。
- 接口：WebSocket 协议关闭码 + 文本消息（如 4409/政策文案）。

## 7. Data & Schemas
- sessionConnections: Map<sessionId, { ws, status, lastError }>.
- 关闭事件 payload：{ code, reason } 记录并显示。
- 计划/消息缓存沿用现有结构，按 sessionId 命名空间。

## 8. APIs / Integration Points
| Endpoint | Method | Contract | Auth | Notes |
| -------- | ------ | -------- | ---- | ----- |
| WS / (current path) | WebSocket | protocols: ads-token, ads-session | ADS_WEB_TOKEN | 前端建立多实例，服务器返回关闭码/消息 |

## 9. Operational Considerations
### 9.1 Error Handling & Fallbacks
- 超限：收到 4409/自定义 reason 时，提示“已达上限(ADS_WEB_MAX_CLIENTS=env)，关闭会话或重试”；保持其他 WS 不变。
- 鉴权失败：沿用现有 token 提示；仅影响该会话。
- 断线重连：每会话独立重连，带退避；失败时不影响其它。

### 9.2 Observability
- 前端 console 记录 WS 状态含 sessionId、code、reason。
- 服务端记录连接/超限事件（token/session 提示信息需避免泄露 token）。

### 9.3 Security & Compliance
- 继续使用 ADS_WEB_TOKEN；不跨会话泄露 token。
- 不新增持久化；仅 sessionStorage。

## 10. Testing & Validation
- 用例：切换多会话不断线；超限建第 N+1 个会话提示且不踢现有；关闭一个后可重连成功；单会话断线不影响其他；消息/计划/草稿在切换与重连后保持。
- 手测环境：设置 ADS_WEB_MAX_CLIENTS=2（或配置值），浏览器单标签操作。

## 11. Release & Rollback
- 发布：前端/服务端同步上线；构建后 `npm run build` 校验。
- 回滚：前端退回单 WS 模式（切换时关闭旧 WS）；服务端恢复旧超限策略。

## 12. Risks & Mitigations
- 资源占用上升：上限由 env 控制，默认保护；必要时前端限制同时活跃的会话数。
- 消息路由混淆：严格以 sessionId 绑定 WS 与视图；在事件分发处带 sessionId 检查。
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
