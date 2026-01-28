export type TaskStartHistoryEntry = { role: string; text: string; ts: number; kind?: string };

export type TaskStartMetricName = "PROMPT_INJECTED" | "INJECTION_SKIPPED";

export type TaskStartMetricEvent = { ts?: number; taskId?: string; reason?: string };

export type TaskStartBroadcaster = (payload: unknown) => void;

type TaskStartTaskLike = { id: string; prompt?: string | null };

export function broadcastTaskStart<TTask extends TaskStartTaskLike>(options: {
  task: TTask;
  ts: number;
  markPromptInjected: (taskId: string, now: number) => boolean;
  recordHistory: (entry: TaskStartHistoryEntry) => void;
  recordMetric: (name: TaskStartMetricName, event?: TaskStartMetricEvent) => void;
  broadcast: TaskStartBroadcaster;
}): void {
  const taskId = String(options.task?.id ?? "").trim();
  if (!taskId) {
    options.recordMetric("INJECTION_SKIPPED", { ts: options.ts, reason: "missing_task_id" });
    return;
  }

  const prompt = String(options.task?.prompt ?? "").trim();
  const content = prompt || `Task ${taskId} started at ${new Date(options.ts).toISOString()} (no prompt)`;

  let markResult: "marked" | "already_marked" | "failed" = "already_marked";
  try {
    markResult = options.markPromptInjected(taskId, options.ts) ? "marked" : "already_marked";
  } catch {
    markResult = "failed";
  }

  options.recordHistory({ role: "user", text: content, ts: options.ts, kind: "task" });
  options.broadcast({
    type: "task:event",
    event: "message",
    data: { taskId, role: "user", content },
    ts: options.ts,
  });
  options.recordMetric("PROMPT_INJECTED", {
    ts: options.ts,
    taskId,
    reason: prompt ? markResult : "empty_prompt",
  });

  options.broadcast({
    type: "task:event",
    event: "task:started",
    data: options.task,
    ts: options.ts,
  });
}
