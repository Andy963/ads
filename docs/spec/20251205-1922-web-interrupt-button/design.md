# Web 端中断按钮 - 设计文档

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 与需求一致 |
| Status | Draft | |
| Authors | Codex | |
| Stakeholders | Web 前端 / 后端 | |
| Created | 2025-12-05 | |
| Last Updated | 2025-12-05 | |
| Related Requirements | docs/spec/20251205-1922-web-interrupt-button/01-req.md | |
| Related Implementation Plan | TBD | |

## 2. Context
### 2.1 Problem Statement
- Web 控制台缺少中断入口，误触发或长耗时命令无法立即停止。
- 后端已有基于 AbortSignal 的软中断能力（Telegram `/esc` 复用 `InterruptManager`），但 Web 未暴露触发通道。

### 2.2 Goals
- 在 Web 输入框右侧提供“停止”方块按钮，执行中可点、空闲禁用。
- 点击后向后端发送中断指令，终止当前活跃流（LLM+命令串行），提示输出可能不完整。

### 2.3 Non-Goals / Out of Scope
- 不杀服务进程；不支持并行多流或跨用户中断。
- 不改动 Telegram `/esc` 行为。

## 3. Current State
- 前端：纯静态 HTML/JS 内嵌于 `src/web/server.ts`，WebSocket 消息类型：`prompt`、`command`、`delta`、`result`、`error`、`command`（事件渲染）。
- 后端：`HybridOrchestrator` 支持 `signal` 但 Web 路径未传入；无 Web 侧中断管理器；未处理 “interrupt” 消息。
- 痛点：用户无法主动停止当前流；长回复或危险命令无法及时终止。

## 4. Target State Overview
- 方案摘要：新增停止按钮与 WebSocket “interrupt” 消息；后端维护 per-user AbortController 并将 signal 传递给 orchestrator/send；中断后立即反馈提示。
- 关键收益：可控性/安全性提升，避免误操作继续执行。
- 主要风险：部分命令已落盘不可回滚；需确保不影响现有 prompt/command 流程。

### 4.1 Architecture Diagram
```
User (Web UI)
  | click stop (when active)
  v
WebSocket send {type:"interrupt"}
  |
Web server (session + interrupt mgr)
  |--> abort controller for user -> passes signal to orchestrator send
  |--> sends {type:"error"/"result", message:"已中断"} to client
  v
HybridOrchestrator -> Agent adapter (Codex/Claude)
  (observes AbortSignal, stops stream/run)
```

### 4.2 Deployment / Topology
- 同现有 Web 服务，新增逻辑内嵌于 `src/web/server.ts`，无新增服务节点。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | 增加 WebSocket “interrupt” 上行消息；下行可复用 `error`/`result` 提示中断。 |
| 控制流 | 每次 prompt/command 开始时注册 AbortController；按钮触发时调用 abort；结束时清理。 |
| 并发/容错 | 单活跃流假设；收到 interrupt 时若无活跃请求则无操作。 |
| 可扩展性 | 若未来支持并行流，可扩展为 per-message-id 的 abort map。 |

### 5.1 Sequence / Flow Diagram
```
User click stop -> WS send {type:"interrupt"}
Server:
  if active controller -> abort(); send {type:"result"/"error", message:"已中断，输出可能不完整"}
  else send harmless status
Client:
  - 停止按钮禁用
  - 在日志区域插入“已中断，输出可能不完整”
  - 输入框可继续使用
```

## 6. Components & Interfaces

### Component W1: Web 前端 UI
- 责任：展示停止按钮、控制可用状态、发送 “interrupt”、提示中断。
- 输入：当前执行状态（已有 sendQueue / streamState）、WS 连接状态。
- 输出：WS 消息 `{type:"interrupt"}`；UI 状态更新（按钮启用/禁用；提示）。
- 关键接口：WebSocket send；按钮 DOM 事件；状态判定（执行中＝有 pending sendQueue 或 streamState/activeCommand）。
- 修改影响面：`src/web/server.ts` 内嵌 HTML/JS；需避免影响现有输入/附件/滚动逻辑。

### Component W2: Web 后端中断管理
- 责任：管理 per-user AbortController，暴露 interrupt 操作。
- 输入：WebSocket “interrupt” 消息；prompt/command 执行上下文。
- 输出：调用 abort()；向前端回传中断结果（复用 `result`/`error`）。
- 关键接口：`HybridOrchestrator.send(input, { streaming:true, signal })`；新建/清理 AbortController。
- 修改影响面：`src/web/server.ts`（连接上下文 + 消息处理）。

## 7. Data & Schemas
- WebSocket 上行新增：
  ```
  { "type": "interrupt" }
  ```
- 无需新增下行类型，复用：
  - `result`：`{ ok:false, output:"已中断，输出可能不完整" }`（prompt）
  - `command`/`error`：命令执行路径可回传状态文本。

## 8. APIs / Integration Points
| Endpoint | Method | Contract | Auth | Notes |
| -------- | ------ | -------- | ---- | ----- |
| WebSocket message | interrupt | `{type:"interrupt"}` | 复用现有 token | 新增 |
| WebSocket message | prompt/command | 现有 | 复用 | signal 注入 |

## 9. Operational Considerations
### 9.1 Error Handling & Fallbacks
- 如果未找到活跃 controller：返回状态提示“无正在执行的任务”。
- 如果 agent 已完成但消息未消费：abort 无害；仍回复提示。
- 用户反馈：在 UI 插入“已中断，输出可能不完整”。

### 9.2 Observability
- 日志：Web 服务记录 interrupt 触发（userId/token、是否找到 active）。
- 指标：可选，不强制。

### 9.3 Security & Compliance
- 认证：沿用 ADS_WEB_TOKEN；中断仅作用于当前连接用户的会话。

## 10. 测试与验证
- 场景用例：
  - 执行 prompt 流式输出时点击停止，输出停止并出现提示。
  - 执行命令时点击停止，命令输出停止（或尽力）并提示。
  - 空闲状态点击停止，返回“无任务”提示。
  - 重连后状态恢复，按钮禁用，发送新请求后可再次中断。
- 验证方式：手动联调；后端日志检查 abort 触发。

## 11. 变更与发布
- 发布步骤：按实施计划合入前端/后端变更，验证手动用例。
- 回滚策略：移除停止按钮入口并禁用 interrupt 消息处理；后端保留现有逻辑不受影响。
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
