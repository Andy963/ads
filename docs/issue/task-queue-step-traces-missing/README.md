# Issue: Task Queue 任务执行期间缺失阶段性说明与中间状态跟踪

## 1. 现象描述 (Symptom)

在 ADS 中，任务执行状态在不同模式下存在显著的表现差异：

* **正常交互式会话 (Interactive Chat)**：
  前端界面除了展示当前正在执行的命令块外，还会伴随丰富的阶段性文字说明（例如 `[analysis]` 思考分析、`[tool]` 工具调用、`[editing]` 文件修改等 live step trace），帮助用户清晰感知 Agent 当前所处的工作阶段。
* **任务队列模式 (Task Queue)**：
  前端仅显示当前最新执行的命令块（Command Execution Block）。在整个执行过程中，所有思考过程、分析说明与阶段性状态均不展示，直到任务最终完成时才直接输出结果。

---

## 2. 根因分析 (Root Cause)

经过对 ADS 前后端代码架构的深入排查，确认该问题是由于**后端任务队列执行器的代码过滤机制**所导致，与使用的具体模型无关。

### 2.1 后端执行器硬编码过滤中间事件 (Backend Event Drop)

在正常会话中，`server/web/server/ws/workerPromptHandler.ts` 监听并转发了所有生命周期事件：

```ts
// server/web/server/ws/workerPromptHandler.ts
if (
  event.phase === "boot" ||
  event.phase === "analysis" ||
  event.phase === "context" ||
  event.phase === "editing" ||
  event.phase === "tool" ||
  event.phase === "connection"
) {
  const line = formatStepTraceLine(event);
  if (line) {
    args.sendToChat({ type: "delta", delta: line, source: "step" });
  }
}
```

但在任务队列执行器 `server/tasks/executor.ts` (`OrchestratorTaskExecutor`) 中，事件监听器进行了硬编码过滤，仅处理了 `command` 与 `responding`：

```ts
// server/tasks/executor.ts
const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
  try {
    // 1. Only handles final text response
    if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
      const merged = mergeStreamingText(respondingText, event.delta);
      respondingText = merged.full;
      if (merged.delta) {
        options?.hooks?.onMessageDelta?.({ role: "assistant", delta: merged.delta, modelUsed: modelForStorage });
      }
      return;
    }
    // 2. Only handles command executions
    if (event.phase === "command" && event.title === "执行命令" && event.detail) {
      const command = String(event.detail).split(" | ")[0]?.trim();
      if (command) {
        // ...
        options?.hooks?.onCommand?.({ command });
      }
    }
    // All other phases (analysis, tool, editing, reasoning) are completely dropped
  } catch {
    // ignore
  }
});
```

### 2.2 消息源类型固定为 chat (Fixed Source Type)

在 `server/tasks/queue.ts` 中，任务队列派发增量消息时，`source` 字段被固定写死为 `"chat"`：

```ts
// server/tasks/queue.ts
onMessageDelta: (message: { role: string; delta: string; modelUsed?: string | null }) =>
  this.emit("message:delta", {
    task: runningTask,
    role: message.role,
    delta: message.delta,
    modelUsed: message.modelUsed,
    source: "chat",
  }),
```

从未生成或透传能够触发前端阶段性追踪的 `source: "step"`。

### 2.3 前端渲染机制已就绪 (Frontend Ready but Starved)

在前端 `client/src/app/tasks/events.ts` 中，任务事件处理器早已实现了针对 `source: "step"` 的阶段性增量渲染逻辑：

```ts
// client/src/app/tasks/events.ts
case "message:delta": {
  const data = parseMessageDeltaEvent(payload.data);
  if (!data || data.role !== "assistant") return;
  markTaskChatStarted(data.taskId, state);
  if (data.source === "step") {
    upsertStepLiveDelta(data.delta, state);
  } else {
    upsertStreamingDelta(data.delta, state);
  }
  return;
}
```

前端具备接收并实时展示阶段说明的能力，但由于后端从未发出 `source: "step"` 消息，导致界面仅能显示命令块。

### 2.4 Prompt 约束进一步抑制文本输出 (Prompt Constraint)

在 `server/tasks/executor.ts` 构建任务执行 Prompt 时，注入了显式规则：
`- 直接完成任务，不要输出多余的流程性内容`。
该规则要求模型专注于工具调用与目标实现，进一步抑制了模型主动输出中间阶段陈述的倾向。

---

## 3. 改进建议 (Recommended Fix)

1. **扩展 TaskExecutorHooks 与事件转发**：
   在 `server/tasks/executor.ts` 中引入 `formatStepTraceLine`，监听 `analysis`、`tool`、`editing`、`boot`、`reasoning` 等事件阶段，并通过 `onMessageDelta` 发送带 `source: "step"` 的增量内容。
2. **透传 TaskQueue 中的 source 标识**：
   在 `server/tasks/queue.ts` 与 `TaskExecutorHooks` 中支持透传 `source?: "chat" | "step"`，确保阶段性说明能正确流向 WebSocket 广播。
3. **保持 Prompt 精简与目标导向**：
   保留对核心任务执行的约束，仅依赖底层事件系统分发工具与阶段 trace，兼顾执行速度与界面可见性。

## 4. 实际代码范围与最终决策

本 issue 的修复范围覆盖两条会话入口：

* **后台队列主路径**：`server/tasks/executor.ts` 产生事件，`server/tasks/queue.ts` 转成队列事件，`server/web/server/taskQueue/runtime.ts` 广播到 WebSocket，`client/src/app/tasks/events.ts` 已按 `source` 分流渲染。
* **任务追加聊天路径**：`server/web/server/api/routes/tasks/chat.ts` 独立订阅 orchestrator，当前只广播 `responding` 和 `command`，也必须与主路径保持相同的阶段 trace 行为。

最终决策：复用现有 `AgentEvent` 和前端 `source: "step"` 协议，在后端增加统一的阶段事件格式化/转发逻辑；`responding` 仍只能作为 `source: "chat"`，命令仍走既有 `command` 事件，避免重复显示或把最终答案混入 live-step。阶段 trace 仅允许有限阶段（`boot`、`analysis`、`context`、`editing`、`tool`、`connection`），并保持与正常交互路径一致的文本格式。

实现时必须保证：同一个 orchestrator 事件不会同时由多个订阅器重复广播；取消、失败和完成时订阅都释放；阶段消息不写入 assistant 最终答案存储；未知阶段和空标题被丢弃。

## 5. 否决方案

* **只修改前端**：前端协议和渲染已经支持 `source: "step"`，没有后端数据时无法恢复丢失的事件。
* **让模型主动输出流程文字**：受模型、prompt 和 provider 差异影响，不能提供稳定的生命周期状态，也会污染最终回复。
* **直接转发所有 AgentEvent 或复用 `responding`**：会泄漏内部原始结构、造成重复内容，并破坏现有 chat/live-step 分流契约。
* **只修 `server/tasks/executor.ts`**：`/api/tasks/:id/chat` 走独立执行路径，仍会与队列执行表现不一致。

## 6. 约束

* Worker 只修改实现所需的后端模块及其测试；不得修改数据库结构、任务状态语义或 provider CLI 协议。
* 保持 `TaskQueueEventMap["message:delta"]` 的向后兼容：`source` 继续是可选的 `"chat" | "step"`。
* 不新增脚本或部署动作；完成后按仓库现有命令运行类型检查、后端测试、前端测试和前端构建。
