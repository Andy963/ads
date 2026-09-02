import type { Task, TaskReviewSummary } from "./types.js";

export type TaskQueueGoalUpdate = {
  status: string;
  objective: string;
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
};

export type TaskQueueEventMap = {
  "queue:paused": { reason?: string };
  "queue:resumed": Record<string, never>;
  "task:started": { task: Task };
  "task:running": { task: Task };
  "task:completed": { task: Task };
  "task:failed": { task: Task; error: string };
  "task:cancelled": { task: Task };
  "message": { task: Task; role: string; content: string };
  "message:delta": { task: Task; role: string; delta: string; modelUsed?: string | null; source?: "step" | "chat" };
  "command": { task: Task; command: string };
  "goal:status": { task: Task; goal: TaskQueueGoalUpdate };
  "goal:cleared": { task: Task };
  "review:updated": { task: Task; event: string; message: string; review: TaskReviewSummary };
};

export type TaskQueueEventName = keyof TaskQueueEventMap;
