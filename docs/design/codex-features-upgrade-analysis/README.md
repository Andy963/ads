# Codex 最新特性演进与 ADS 升级可行性分析报告

## 1. 概述与背景 (Executive Summary & Background)

随着 Codex 官方版本的持续迭代（当前运行环境已安装 `codex-cli 0.152.1`），Codex 已经从早期的单会话交互式 CLI，演进为具备目标预算控制、多代理协作（Multi-Agent v2）、Guardian 安全审查以及丰富 App-Server JSON-RPC v2 协议能力的智能编排中枢。

与此同时，ADS 的 Codex 对接层（`server/codex/appServer`、`server/agents/adapters` 以及 `server/tasks`）主要基于较早期的协议结构构建，存在以下几处明显断层：
- **协议绑定落后**：`server/codex/appServer/protocol/` 生成代码落后于 upstream 现行 schema，遗漏了大量 v2 请求、通知及数据结构。
- **推理参数与模型能力未对齐**：未暴露 Codex 现已支持的 `max` 与 `ultra` 推理强度选项，且缺少模型回退时的自适应调整。
- **事件流粒度与阶段追踪缺失**：后端过滤了 `step` 来源的细粒度事件（如 `analysis`、`tool`、`context`），且未接入 `reasoningSummaryTextDelta`、`planDelta` 等增量通知。
- **目标状态机未与 upstream 闭环**：ADS 自身维护 Task 状态，但未将 Codex upstream 的 `thread/goal/*` 协议与 Token 预算机制进行双向绑定。
- **多代理层级不可见**：Codex 内部由 `spawn_agent` 派生的子代理调用链与协同过程，在 ADS 前端与任务面板中尚未得到结构化展示。

本文档全面梳理 Codex 0.146.0 至 0.151.0+ 的核心演进特性，对照 ADS 现有架构进行差距分析，并提出可行的模块化升级方案与决策矩阵，供后续架构选型与迭代决策参考。

### Phase 1 交付状态

Phase 1 的低风险基础项已在 `codex-cli 0.152.1` 上落地：协议绑定由仓库脚本重新生成，推理档位默认包含 `max` 与 `ultra`，并将 App-Server 的计划、推理摘要及上下文压缩事件转换为统一的 live step trace。任务队列和追加聊天路径继续复用 `source: "step"` 分流，不会把阶段消息写入最终 assistant 回复。

---

## 2. Codex 核心特性演进全景 (Codex Capabilities Matrix: 0.146 - 0.151+)

| 领域 (Domain) | Codex 最新特性 (0.146 ~ 0.151+) | 核心机制与价值 (Key Mechanism & Value) |
| :--- | :--- | :--- |
| **多代理协作 (Multi-Agent v2)** | `spawn_agent`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` | 层次化子代理编排，子代理 Token 统一汇入根目标预算，活动自动汇聚至发起 Turn |
| **目标与预算控制 (Goals & Budgets)** | `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, `thread/goal/updated` | 结构化目标管理，实时追踪 Token 消耗与剩余预算，超限自动拦截并通知 |
| **高级会话控制 (Thread Lifecycle)** | `thread/fork`, `thread/rollback`, `thread/pin`, `thread/setName`, `thread/archive` | 支持分页历史分叉、临时探索分叉 (ephemeral fork)、指定 Turn 状态回滚与会话置顶 |
| **细粒度事件流 (App-Server v2 Events)** | `planDelta`, `reasoningSummaryTextDelta`, `agentMessageDelta`, `processOutputDelta` | 增量任务计划、思维链摘要、终端 PTY 流式分帧与上下文压缩 (`contextCompacted`) 通知 |
| **安全与权限审查 (Guardian V2)** | `Guardian V2`, `ActivePermissionProfile`, `AdditionalPermissionProfile` | 基于单 Token 分类的低延迟风险评分，沙箱命令免打扰执行，持久化会话权限无损恢复 |
| **Skills 与 MCP 生态** | `Skill Catalog Budgeting`, `Agent Plugins`, `Dynamic MCP`, `MCP Tool Hooks` | 基于上下文窗口自适应裁剪 Skill 预算，支持插件清单标准与动态 MCP 工具拦截 |
| **推理档位 (Reasoning Effort)** | `max`, `ultra` 推理档位与自适应模型降级 | 支持最新大模型（如 GPT-5.6-sol 等）的深度推理需求与错误自动重试策略 |

---

## 3. ADS 现有架构与 Codex 对接层现状诊断 (Current ADS Architecture Analysis)

当前 ADS 涉及 Codex 调用的核心组件与现状如下：

```
+-----------------------------------------------------------------------------------+
|                                 ADS System Architecture                           |
+-----------------------------------------------------------------------------------+
| Web UI / TaskBoard / MainChat (Vue 3)                                             |
|   ^                                                                               |
|   | WebSocket (Task Events, Streaming Deltas, Goal Updates)                       |
|   v                                                                               |
| server/web/server.ts & server/tasks/queue.ts                                      |
|   ^                                                                               |
|   | Task Execution Dispatches                                                     |
|   v                                                                               |
| server/tasks/executor.ts (OrchestratorTaskExecutor)                               |
|   ^                                                                               |
|   | Agent Selection & Prompt Composition                                          |
|   v                                                                               |
| server/agents/orchestrator.ts (HybridOrchestrator)                                |
|   ^                                                                               |
|   +---> server/agents/adapters/codexAppServerAdapter.ts                           |
|   |       |                                                                       |
|   |       +---> server/codex/appServer/rpcClient.ts (JSON-RPC over stdio)         |
|   |       +---> server/codex/appServer/daemonRegistry.ts (Project-level daemon)   |
|   |       +---> server/codex/appServer/protocol/ (Generated Type Bindings)        |
|   |                                                                               |
|   +---> server/agents/adapters/codexCliAdapter.ts (Direct CLI Runner fallback)    |
+-----------------------------------------------------------------------------------+
```

### 核心诊断结论
1. **`server/codex/appServer/protocol/` 类型陈旧**：现有类型生成物缺少 v2 协议中新增的字段与枚举（例如 `PlanDeltaNotification`、`ReasoningSummaryTextDeltaNotification`、`CollabAgentState` 等）。
2. **`server/codex/events.ts` 事件映射不全**：现有映射器仅处理基础的 `command_execution`、`file_change`、`tool_call`，未能捕获和格式化 Codex 的计划更新与多代理协同事件。
3. **`server/tasks/executor.ts` 事件过滤问题**：Task Queue 在执行过程中，仅向外广播 `responding` delta 与 `command` 事件，导致分析阶段（`analysis`、`tool`、`context`）的 step-trace 无法在前端实时呈现。
4. **Goal 机制脱节**：前端与数据库中虽然有 Task 目标与状态概念，但执行时未充分利用 upstream 的 `thread/goal/set` 强约束，缺乏基于 Token Budget 的自动中止与结算能力。

---

## 4. 可更新特性详细设计与分析 (Detailed Upgrade Areas)

### 4.1 协议层与高阶推理对齐 (Protocol Bindings & Reasoning Effort)

#### 4.1.1 现状与痛点
- `scripts/generate-codex-app-server-types.js` 未定期触发，下游代码无法享受 upstream 强类型校验；
- `server/agents/adapters/codexAppServerAdapter.ts` 与 Web 端仅允许配置 `low`, `medium`, `high`，不支持最新的 `max` 与 `ultra` 档位。

#### 4.1.2 改造方案
- 执行生成脚本重新拉取 0.151.0 协议并保证 NodeNext 模块后缀兼容性；
- 扩展推理配置类型定义并更新前端模型选择器：
```typescript
export type ExtendedReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
```

---

### 4.2 事件流增强与执行过程全透传 (Event Pipeline & Live Traces)

#### 4.2.1 现状与痛点
- 用户在任务执行过程中，往往只能看到最终的输出文字或执行完的命令，缺乏对 Agent “正在分析什么”、“正在查阅哪些文件”的实时感知；
- upstream 已支持增量思考摘要（`reasoningSummaryTextDelta`）与计划增量（`planDelta`），但 ADS 尚未消费。

#### 4.2.2 改造方案
1. **在 `server/codex/events.ts` 扩充事件类型**：
```typescript
export type AgentPhase =
  | "boot"
  | "analysis"
  | "plan"
  | "context"
  | "editing"
  | "tool"
  | "command"
  | "subagent"
  | "responding"
  | "completed"
  | "connection"
  | "error";
```
2. **在 `server/tasks/executor.ts` 中放行所有阶段的 Step Trace**：
```typescript
if (isStepTracePhase(event.phase)) {
  const formatted = formatStepTraceLine(event);
  if (formatted) {
    hooks?.onMessageDelta?.({
      role: "assistant",
      delta: formatted,
      modelUsed: task.model,
      source: "step",
    });
  }
}
```
3. **前端渲染优化**：在 TaskBoard 与 MainChat 中将 `source === "step"` 的消息渲染为可折叠的实时步进面板。

---

### 4.3 原生 Goal 状态机与 Token 预算闭环 (Thread Goals & Token Budgeting)

#### 4.3.1 现状与痛点
- 当前 ADS Task 的完成状态主要依靠提示词指令（如 `update_plan` 或文本模式匹配）进行弱推导；
- 缺乏精确的 Token 预算熔断机制，长任务可能无限制消耗算力。

#### 4.3.2 改造方案
1. **任务启动时注入 Goal 与 Budget**：
```typescript
await client.request("thread/goal/set", {
  threadId,
  objective: task.title + "\n" + task.description,
  tokenBudget: task.tokenBudget ?? undefined,
});
```
2. **监听 `thread/goal/updated` 通知**：
   - 实时获取 `tokensUsed` 与 `timeUsedSeconds`；
   - 当 upstream 触发 `status: "complete"` 或 `status: "blocked"` 时，自动同步更新 ADS TaskStore 中的任务状态。

---

### 4.4 多代理协作层级透传 (Multi-Agent v2 Observability)

#### 4.4.1 现状与痛点
- Codex 0.151.0 已支持 `spawn_agent`、`followup_task` 等多子代理并发调度；
- ADS 仅将整个 Codex 视为单一黑盒 Adapter，子代理活动与父 Turn 混在一起，用户无法感知任务分解层级。

#### 4.4.2 改造方案
1. **捕获 Subagent 生命周期事件**：
   - 监听 `item.started` / `item.completed` 中的 `spawn_agent`、`send_message`、`wait_agent` 等工具调用；
   - 维护当前 Turn 的 Agent Tree 结构：
```typescript
export interface SubAgentCallNode {
  agentId: string;
  taskName: string;
  parentTurnId: string;
  status: "running" | "completed" | "interrupted" | "failed";
  tokensUsed?: number;
}
```
2. **UI 层呈现**：在 MainChat 和 TaskBoard 详情抽屉中提供树状调用堆栈（Tree View），可单独展开子代理的执行轨迹与结果。

---

### 4.5 高级会话生命周期控制 (Thread Forking, Rollback & Pinning)

#### 4.5.1 现状与痛点
- 当某个 Task 执行出错或偏离方向时，用户只能选择重新新建 Task 或手动修改，无法回到特定历史检查点分叉；
- 缺乏对高频会话的置顶与归档机制。

#### 4.5.2 改造方案
1. **会话分叉 (Fork)**：
   - 利用 `thread/fork` 协议，从指定的 `turnId` 或完整历史生成新的 threadId，支持派生实验任务。
2. **会话回滚 (Rollback)**：
   - 利用 `thread/rollback` 协议，快速撤销上一步执行不良的 Turn 及产生的文件改动。
3. **置顶与归档**：
   - 对齐 `thread/pin` 与 `thread/archive`，同步维护 ADS 本地数据库的标记字段。

---

### 4.6 安全防护与权限模型集成 (Guardian V2 & Permission Profiles)

#### 4.6.1 现状与痛点
- ADS 现有的沙箱模式较为粗粒度（`danger-full-access` vs 普通沙箱）；
- 会话 Resume 时容易出现权限配置漂移问题。

#### 4.6.2 改造方案
- 在 App-Server 会话启动参数中绑定 `ActivePermissionProfile`；
- 接入 Guardian V2 的审批通知流（`guardianWarningNotification` 与 `commandExecution/requestApproval`），在 Web 端或 Telegram 端弹出结构化审批卡片（卡片展示风险等级、目标文件与命令解释）。

---

## 5. 权衡矩阵与可行性评估 (Cost-Benefit & Feasibility Matrix)

| 升级特性 (Feature) | 实现复杂度 (Complexity) | 稳定性风险 (Risk) | 业务价值 (ROI) | 推荐优先级 (Priority) |
| :--- | :--- | :--- | :--- | :--- |
| **1. 协议绑定重新生成与编译兼容** | 极低 (Low) | 极低 (Zero Risk) | 基础性保障，获得完整类型支持 | **P0 (必做)** |
| **2. 推理档位 (`max`/`ultra`) 支持** | 极低 (Low) | 极低 | 满足高质量复杂任务推理需求 | **P0 (必做)** |
| **3. Task Queue 阶段步进事件透传** | 低 (Low) | 极低 | 显著提升任务运行透明度 | **P0 (必做)** |
| **4. 原生 Goal 状态与 Token 预算闭环** | 中等 (Medium) | 低 (需保证向下兼容) | 解决状态判断脆弱性与算力浪费 | **P1 (推荐)** |
| **5. Multi-Agent v2 子代理树透传** | 中等 (Medium) | 低 | 增强复杂任务可视化体验 | **P1 (推荐)** |
| **6. Thread Fork / Rollback 交互** | 中等 (Medium) | 低 | 提升任务纠错与调试效率 | **P2 (可选)** |
| **7. Guardian V2 动态审批卡片** | 高 (High) | 中等 | 增强多端交互安全性 | **P2 (可选)** |
| **8. WebRTC Realtime 语音集成** | 极高 (High) | 较高 | 语音实时对齐 (当前需求不急迫) | **P3 (暂缓)** |

---

## 6. 演进路线图与决策建议 (Phased Implementation Roadmap)

建议采取“**协议先行 -> 观测增强 -> 状态与编排闭环 -> 高级交互扩展**”的分阶段策略：

```
+-----------------------------------------------------------------------------+
| 阶段一 (Phase 1): 协议校准与观测基建 (预计改动范围最小，零风险)                |
| - 重新生成 server/codex/appServer/protocol/ 类型文件                        |
| - 扩充 ExtendedReasoningEffort 支持 max / ultra 选项                        |
| - 修复 Task Queue 中对 step 阶段事件的过滤与透传                             |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| 阶段二 (Phase 2): Goal 预算与 Multi-Agent 可观测性 (核心业务价值)             |
| - OrchestratorTaskExecutor 接入 thread/goal/set 与 thread/goal/updated 通知   |
| - 捕获 spawn_agent 等协同事件并在 WebSocket 与前端构建 Agent 调用链路         |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| 阶段三 (Phase 3): 会话高级控制与安全治理 (体验与控制力增强)                    |
| - Web 端接入 thread/fork (派生分支任务) 与 thread/rollback (快速撤销)        |
| - 接入 ActivePermissionProfile 持久化与 Guardian 审批拦截                    |
+-----------------------------------------------------------------------------+
```

---

## 7. 结论与下一步 (Next Steps)

本报告系统分析了 Codex 0.151.0+ 对 ADS 的潜在价值。总体而言：
1. **阶段一（Phase 1）属于低垂果实**：仅涉及类型更新、枚举扩充与事件透传修复，改动集中且对现有功能完全后向兼容；
2. **阶段二（Phase 2）是架构进阶的关键**：将 ADS 的 Task 编排与 Codex 原生的 Goal/Token 预算深度契合，能够彻底解决任务状态漂移与黑盒问题；
3. **阶段三（Phase 3）可视后续使用场景按需逐步推进**。

待用户审阅本设计文档并明确所需特性后，即可针对选定阶段进行精准落地与测试验证。
