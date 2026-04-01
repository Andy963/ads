import type { TaskStore } from "../../../tasks/store.js";
import type { ConversationMessage, Task, TaskStatus } from "../../../tasks/types.js";

const TASK_RESUME_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];
const TASK_RESUME_CONVERSATION_LIMIT = 24;
const TASK_RESUME_TRANSCRIPT_MAX_CHARS = 10_000;

export type TaskResumeConversationContext = {
  task: Task;
  transcript: string;
};

function getTaskActivityTs(task: Task): number {
  return (task.completedAt ?? task.startedAt ?? task.createdAt) ?? 0;
}

export function selectMostRecentTaskResumeCandidate(tasks: readonly Task[]): Task | null {
  return (
    tasks
      .slice()
      .sort((a, b) => getTaskActivityTs(b) - getTaskActivityTs(a))[0] ?? null
  );
}

export function buildTaskResumeTranscript(
  messages: readonly ConversationMessage[],
  maxChars = TASK_RESUME_TRANSCRIPT_MAX_CHARS,
): string {
  const rawTranscript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${String(message.content ?? "").trim()}`)
    .filter(Boolean)
    .join("\n");

  return rawTranscript.length <= maxChars
    ? rawTranscript
    : rawTranscript.slice(rawTranscript.length - maxChars);
}

export function loadTaskResumeConversationContext(
  taskStore: Pick<TaskStore, "listTasks" | "getConversationMessages">,
): TaskResumeConversationContext | null {
  const candidates = TASK_RESUME_STATUSES.flatMap((status) => taskStore.listTasks({ status, limit: 50 }));
  const task = selectMostRecentTaskResumeCandidate(candidates);
  if (!task) {
    return null;
  }

  const conversationId =
    String(task.threadId ?? "").trim() || `conv-${String(task.id ?? "").trim()}`;
  const transcript = buildTaskResumeTranscript(
    taskStore.getConversationMessages(conversationId, { limit: TASK_RESUME_CONVERSATION_LIMIT }),
  );

  return { task, transcript };
}
