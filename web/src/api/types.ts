export type TaskStatus =
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type PlanStepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  status: TaskStatus;
  priority: number;
  inheritContext: boolean;
  result?: string | null;
  error?: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  createdBy?: string | null;
  attachments?: Attachment[];
}

export interface PlanStep {
  id: number;
  taskId: string;
  stepNumber: number;
  title: string;
  description?: string | null;
  status: PlanStepStatus;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface TaskMessage {
  id: number;
  taskId: string;
  planStepId?: number | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  messageType?: string | null;
  modelUsed?: string | null;
  tokenCount?: number | null;
  createdAt: number;
}

export interface TaskDetail extends Task {
  plan: PlanStep[];
  messages: TaskMessage[];
}

export interface Attachment {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
}

export interface CreateTaskInput {
  title?: string;
  prompt: string;
  model?: string;
  priority?: number;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
}

export interface ModelConfig {
  id: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
}

export interface TaskQueueStatus {
  enabled: boolean;
  ready: boolean;
  streaming: boolean;
  error?: string;
}

export type TaskEventPayload =
  | { event: "task:started"; data: Task }
  | { event: "task:updated"; data: Task }
  | { event: "task:running"; data: Task }
  | { event: "task:completed"; data: Task }
  | { event: "task:cancelled"; data: Task }
  | { event: "task:failed"; data: { task: Task; error: string } }
  | { event: "task:planned"; data: { task: Task; plan: Array<{ stepNumber: number; title: string; description?: string | null }> } }
  | { event: "step:started"; data: { taskId: string; step: { stepNumber: number; title: string; description?: string | null } } }
  | { event: "step:completed"; data: { taskId: string; step: { stepNumber: number; title: string; description?: string | null } } }
  | { event: "message"; data: { taskId: string; role: string; content: string } }
  | { event: "message:delta"; data: { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" } }
  | { event: "command"; data: { taskId: string; command: string } };
