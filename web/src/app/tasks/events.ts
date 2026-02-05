import type { Task, TaskEventPayload } from "../../api/types";
import type { ChatActions } from "../chat";
import type { AppContext, ProjectRuntime } from "../controller";

export function createTaskEventActions(
  ctx: AppContext & ChatActions,
  deps: {
    upsertTask: (t: Task, rt?: ProjectRuntime) => void;
    removeTask: (taskId: string, rt: ProjectRuntime) => void;
    loadQueueStatus: (projectId?: string) => Promise<void>;
  },
) {
  const { randomId } = ctx;
  const {
    pruneTaskChatBuffer,
    markTaskChatStarted,
    ingestCommand,
    upsertExecuteBlock,
    upsertStepLiveDelta,
    upsertStreamingDelta,
    finalizeAssistant,
    hasAssistantAfterLastUser,
    hasEmptyAssistantPlaceholder,
    pushMessageBeforeLive,
    flushQueuedPrompts,
    finalizeCommandBlock,
    clearStepLive,
  } = ctx;
  const { upsertTask, removeTask, loadQueueStatus } = deps;

  const shouldHideTask = (t: Task): boolean => {
    return t.status === "completed" && t.archivedAt != null;
  };

  const onTaskEvent = (payload: { event: TaskEventPayload["event"]; data: unknown }, rt?: ProjectRuntime): void => {
    const state = ctx.runtimeOrActive(rt);
    pruneTaskChatBuffer(state);
    if (payload.event === "task:deleted") {
      const data = payload.data as { taskId?: unknown };
      const taskId = String(data?.taskId ?? "").trim();
      if (taskId) {
        removeTask(taskId, state);
      }
      return;
    }
    if (payload.event === "task:updated") {
      const t = payload.data as Task;
      if (shouldHideTask(t)) {
        removeTask(t.id, state);
        return;
      }
      upsertTask(t, state);
      return;
    }
    if (payload.event === "command") {
      const data = payload.data as { taskId: string; command: string };
      markTaskChatStarted(data.taskId, state);
      ingestCommand(data.command, state, null);
      upsertExecuteBlock(`task:${String(data.taskId ?? "").trim()}:${randomId("cmd")}`, data.command, "", state);
      return;
    }
    if (payload.event === "message:delta") {
      const data = payload.data as {
        taskId: string;
        role: string;
        delta: string;
        modelUsed?: string | null;
        source?: "chat" | "step";
      };
      if (data.role === "assistant") {
        markTaskChatStarted(data.taskId, state);
        if (data.source === "step") {
          upsertStepLiveDelta(data.delta, state);
        } else {
          upsertStreamingDelta(data.delta, state);
        }
      }
      return;
    }
    if (payload.event === "task:started") {
      const t = payload.data as Task;
      upsertTask(t, state);
      finalizeCommandBlock(state);
      markTaskChatStarted(t.id, state);
      return;
    }
    if (payload.event === "task:running") {
      const t = payload.data as Task;
      upsertTask(t, state);
      markTaskChatStarted(t.id, state);
      return;
    }
    if (payload.event === "message") {
      const data = payload.data as { taskId: string; role: string; content: string };
      const taskId = String(data.taskId ?? "").trim();
      const role = String(data.role ?? "").trim();
      const content = String(data.content ?? "");

      if (role === "user" && !state.startedTaskIds.has(taskId)) {
        ctx.bufferTaskChatEvent(taskId, { kind: "message", role: "user", content }, state);
        return;
      }
      if (role !== "user") {
        markTaskChatStarted(taskId, state);
      }
      if (role === "assistant") {
        finalizeAssistant(content, state);
        return;
      }
      if (role === "user") {
        const normalized = content.trim();
        if (state.messages.value.some((m) => m.role === "user" && m.kind === "text" && String(m.content ?? "").trim() === normalized)) {
          return;
        }
        pushMessageBeforeLive({ role: "user", kind: "text", content }, state);
        const task = state.tasks.value.find((t) => t.id === taskId) ?? null;
        const status = String(task?.status ?? "");
        if (status === "pending" || status === "planning" || status === "running") {
          if (!hasEmptyAssistantPlaceholder(state)) {
            pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
          }
        }
        return;
      }
      if (role === "system") {
        pushMessageBeforeLive({ role: "system", kind: "text", content }, state);
        return;
      }
      return;
    }
    if (payload.event === "task:completed") {
      const t = payload.data as Task;
      markTaskChatStarted(t.id, state);
      if (shouldHideTask(t)) {
        removeTask(t.id, state);
      } else {
        upsertTask(t, state);
      }
      clearStepLive(state);
      finalizeCommandBlock(state);
      if (t.result && t.result.trim() && !hasAssistantAfterLastUser(state)) {
        finalizeAssistant(t.result, state);
      }
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
    if (payload.event === "task:failed") {
      const data = payload.data as { task: Task; error: string };
      markTaskChatStarted(data.task.id, state);
      upsertTask(data.task, state);
      clearStepLive(state);
      finalizeCommandBlock(state);
      pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` }, state);
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
    if (payload.event === "task:cancelled") {
      const t = payload.data as Task;
      markTaskChatStarted(t.id, state);
      upsertTask(t, state);
      clearStepLive(state);
      finalizeCommandBlock(state);
      pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" }, state);
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
  };

  return { onTaskEvent };
}
