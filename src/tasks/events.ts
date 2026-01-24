import type { PlanStepInput, Task } from "./types.js";

export type TaskQueueEventMap = {
  "queue:paused": { reason?: string };
  "queue:resumed": Record<string, never>;
  "task:started": { task: Task };
  "task:planned": { task: Task; plan: PlanStepInput[] };
  "task:running": { task: Task };
  "task:completed": { task: Task };
  "task:failed": { task: Task; error: string };
  "task:cancelled": { task: Task };
  "step:started": { task: Task; step: PlanStepInput };
  "step:completed": { task: Task; step: PlanStepInput };
  "message": { task: Task; role: string; content: string };
  "message:delta": { task: Task; role: string; delta: string; modelUsed?: string | null; source?: "step" | "chat" };
  "command": { task: Task; command: string };
};

export type TaskQueueEventName = keyof TaskQueueEventMap;
