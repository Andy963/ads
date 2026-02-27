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

  const shouldHideTask = (task: Task): boolean => task.status === "completed" && task.archivedAt != null;

  const upsertOrRemoveTask = (task: Task, state: ProjectRuntime): void => {
    if (shouldHideTask(task)) {
      removeTask(task.id, state);
      return;
    }
    upsertTask(task, state);
  };

  const startTaskTerminalCleanup = (taskId: string, state: ProjectRuntime): void => {
    markTaskChatStarted(taskId, state);
    clearStepLive(state);
    finalizeCommandBlock(state);
  };

  const finishTaskTerminalCleanup = (state: ProjectRuntime): void => {
    flushQueuedPrompts(state);
    void loadQueueStatus();
  };

  const onTaskMessage = (data: { taskId: string; role: string; content: string }, state: ProjectRuntime): void => {
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
      if ((status === "pending" || status === "planning" || status === "running") && !hasEmptyAssistantPlaceholder(state)) {
        pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
      }
      return;
    }
    if (role === "system") {
      pushMessageBeforeLive({ role: "system", kind: "text", content }, state);
    }
  };

  const onTaskEvent = (payload: { event: TaskEventPayload["event"]; data: unknown }, rt?: ProjectRuntime): void => {
    const state = ctx.runtimeOrActive(rt);
    pruneTaskChatBuffer(state);

    switch (payload.event) {
      case "task:deleted": {
        const data = payload.data as { taskId?: unknown };
        const taskId = String(data?.taskId ?? "").trim();
        if (taskId) {
          removeTask(taskId, state);
        }
        return;
      }
      case "task:updated": {
        const task = payload.data as Task;
        upsertOrRemoveTask(task, state);
        return;
      }
      case "command": {
        const data = payload.data as { taskId: string; command: string };
        const taskId = String(data.taskId ?? "").trim();
        markTaskChatStarted(taskId, state);
        ingestCommand(data.command, state, null);
        upsertExecuteBlock(`task:${taskId}:${randomId("cmd")}`, data.command, "", state);
        return;
      }
      case "message:delta": {
        const data = payload.data as {
          taskId: string;
          role: string;
          delta: string;
          modelUsed?: string | null;
          source?: "chat" | "step";
        };
        if (data.role !== "assistant") {
          return;
        }
        markTaskChatStarted(data.taskId, state);
        if (data.source === "step") {
          upsertStepLiveDelta(data.delta, state);
        } else {
          upsertStreamingDelta(data.delta, state);
        }
        return;
      }
      case "task:started": {
        const task = payload.data as Task;
        upsertTask(task, state);
        finalizeCommandBlock(state);
        markTaskChatStarted(task.id, state);
        return;
      }
      case "task:running": {
        const task = payload.data as Task;
        upsertTask(task, state);
        markTaskChatStarted(task.id, state);
        return;
      }
      case "message": {
        onTaskMessage(payload.data as { taskId: string; role: string; content: string }, state);
        return;
      }
      case "task:completed": {
        const task = payload.data as Task;
        markTaskChatStarted(task.id, state);
        upsertOrRemoveTask(task, state);
        clearStepLive(state);
        finalizeCommandBlock(state);
        if (task.result && task.result.trim() && !hasAssistantAfterLastUser(state)) {
          finalizeAssistant(task.result, state);
        }
        finishTaskTerminalCleanup(state);
        return;
      }
      case "task:failed": {
        const data = payload.data as { task: Task; error: string };
        startTaskTerminalCleanup(data.task.id, state);
        upsertTask(data.task, state);
        pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` }, state);
        finishTaskTerminalCleanup(state);
        return;
      }
      case "task:cancelled": {
        const task = payload.data as Task;
        startTaskTerminalCleanup(task.id, state);
        upsertTask(task, state);
        pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" }, state);
        finishTaskTerminalCleanup(state);
        return;
      }
    }
  };

  return { onTaskEvent };
}
