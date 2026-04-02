import type { TaskStore } from "../../../tasks/store.js";
import type { ConversationMessage, Task, TaskStatus } from "../../../tasks/types.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";

const TASK_RESUME_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];
const TASK_RESUME_CONVERSATION_LIMIT = 24;
const TASK_RESUME_TRANSCRIPT_MAX_CHARS = 10_000;

export type TaskResumeConversationContext = {
  task: Task;
  transcript: string;
};

type TaskResumeTranscriptLine = {
  speaker: "User" | "Assistant";
  text: string;
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
  const rawTranscript = buildResumeTranscriptLines(
    messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        speaker: message.role === "user" ? "User" : "Assistant",
        text: String(message.content ?? "").trim(),
      })),
  );

  return rawTranscript.length <= maxChars
    ? rawTranscript
    : rawTranscript.slice(rawTranscript.length - maxChars);
}

export function buildHistoryStoreResumeTranscript(
  entries: readonly HistoryEntry[],
  maxChars = TASK_RESUME_TRANSCRIPT_MAX_CHARS,
): string {
  const rawTranscript = buildResumeTranscriptLines(
    entries
      .filter((entry) => entry.role === "user" || entry.role === "ai")
      .map((entry) => ({
        speaker: entry.role === "user" ? "User" : "Assistant",
        text: String(entry.text ?? "").trim(),
      })),
  );

  return rawTranscript.length <= maxChars
    ? rawTranscript
    : rawTranscript.slice(rawTranscript.length - maxChars);
}

function buildResumeTranscriptLines(lines: readonly TaskResumeTranscriptLine[]): string {
  return lines
    .filter((line) => Boolean(line.text))
    .map((line) => `${line.speaker}: ${line.text}`)
    .join("\n");
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
