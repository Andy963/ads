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
  type MessageEvent = { taskId: string; role: string; content: string };
  type CommandEvent = { taskId: string; command: string };
  type MessageDeltaEvent = { taskId: string; role: string; delta: string; source?: "chat" | "step" };
  type TaskFailedEvent = { task: Task; error: string };

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    return value as Record<string, unknown>;
  };

  const asTrimmedString = (value: unknown): string => String(value ?? "").trim();

  const parseTask = (value: unknown): Task | null => {
    const record = asRecord(value);
    if (!record) return null;
    const taskId = asTrimmedString(record.id);
    if (!taskId) return null;
    const task = value as Task;
    if (task.id === taskId) {
      return task;
    }
    return { ...task, id: taskId };
  };

  const parseTaskId = (value: unknown): string => {
    const record = asRecord(value);
    if (!record) return "";
    return asTrimmedString(record.taskId);
  };

  const parseTaskMessage = (value: unknown): MessageEvent | null => {
    const record = asRecord(value);
    if (!record) return null;
    return {
      taskId: asTrimmedString(record.taskId),
      role: asTrimmedString(record.role),
      content: String(record.content ?? ""),
    };
  };

  const parseCommandEvent = (value: unknown): CommandEvent | null => {
    const record = asRecord(value);
    if (!record) return null;
    return {
      taskId: asTrimmedString(record.taskId),
      command: String(record.command ?? ""),
    };
  };

  const parseMessageDeltaEvent = (value: unknown): MessageDeltaEvent | null => {
    const record = asRecord(value);
    if (!record) return null;
    const source = record.source === "step" ? "step" : "chat";
    return {
      taskId: asTrimmedString(record.taskId),
      role: asTrimmedString(record.role),
      delta: String(record.delta ?? ""),
      source,
    };
  };

  const parseTaskFailedEvent = (value: unknown): TaskFailedEvent | null => {
    const record = asRecord(value);
    if (!record) return null;
    const task = parseTask(record.task);
    if (!task) return null;
    return {
      task,
      error: String(record.error ?? ""),
    };
  };

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
    void flushQueuedPrompts(state);
    void loadQueueStatus();
  };

  const onTaskMessage = (data: MessageEvent, state: ProjectRuntime): void => {
    const taskId = asTrimmedString(data.taskId);
    const role = asTrimmedString(data.role);
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
        const taskId = parseTaskId(payload.data);
        if (taskId) {
          removeTask(taskId, state);
        }
        return;
      }
      case "task:updated": {
        const task = parseTask(payload.data);
        if (!task) return;
        upsertOrRemoveTask(task, state);
        return;
      }
      case "command": {
        const data = parseCommandEvent(payload.data);
        if (!data) return;
        const taskId = data.taskId;
        markTaskChatStarted(taskId, state);
        ingestCommand(data.command, state, null);
        upsertExecuteBlock(`task:${taskId}:${randomId("cmd")}`, data.command, "", state);
        return;
      }
      case "message:delta": {
        const data = parseMessageDeltaEvent(payload.data);
        if (!data) return;
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
        const task = parseTask(payload.data);
        if (!task) return;
        upsertTask(task, state);
        finalizeCommandBlock(state);
        markTaskChatStarted(task.id, state);
        return;
      }
      case "task:running": {
        const task = parseTask(payload.data);
        if (!task) return;
        upsertTask(task, state);
        markTaskChatStarted(task.id, state);
        return;
      }
      case "message": {
        const message = parseTaskMessage(payload.data);
        if (!message) return;
        onTaskMessage(message, state);
        return;
      }
      case "task:completed": {
        const task = parseTask(payload.data);
        if (!task) return;
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
        const data = parseTaskFailedEvent(payload.data);
        if (!data) return;
        startTaskTerminalCleanup(data.task.id, state);
        upsertTask(data.task, state);
        pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` }, state);
        finishTaskTerminalCleanup(state);
        return;
      }
      case "task:cancelled": {
        const task = parseTask(payload.data);
        if (!task) return;
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
