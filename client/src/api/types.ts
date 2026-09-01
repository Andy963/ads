export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskCategory = "development" | "review" | "rework";

export type TaskRunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled";
export type TaskRunCaptureStatus = "pending" | "ok" | "failed" | "skipped";
export type TaskRunApplyStatus = "pending" | "applied" | "blocked" | "failed" | "skipped";

export interface TaskRun {
  id: string;
  taskId: string;
  workspaceRoot: string;
  status: TaskRunStatus;
  captureStatus: TaskRunCaptureStatus;
  applyStatus: TaskRunApplyStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export type TaskGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  modelParams?: Record<string, unknown> | null;
  status: TaskStatus;
  priority: number;
  category?: TaskCategory;
  queueOrder: number;
  queuedAt?: number | null;
  promptInjectedAt?: number | null;
  inheritContext: boolean;
  agentId: string | null;
  parentTaskId?: string | null;
  threadId?: string | null;
  result?: string | null;
  error?: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  createdBy?: string | null;
  attachments?: Attachment[];
  latestRun?: TaskRun | null;
  goalMode?: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
  goalStatus?: TaskGoalStatus | null;
  goalTokensUsed?: number | null;
  goalTimeUsedSeconds?: number | null;
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
  filename?: string | null;
}

export interface CreateTaskInput {
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  category?: TaskCategory;
  maxRetries?: number;
  attachments?: string[];
  goalMode?: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
}

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
}

export type RuleSeverity = "advisory" | "required" | "approval_required" | "blocked";

export interface RuleMatch {
  agents?: string[];
  channels?: string[];
  tools?: string[];
  commandPatterns?: string[];
  pathPatterns?: string[];
}

export interface GlobalRule {
  id: string;
  title: string;
  body: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  match: RuleMatch | null;
}

export interface GlobalRuleAuditEntry {
  id: number;
  ruleId: string;
  action: "create" | "update" | "enable" | "disable" | "delete";
  before: GlobalRule | null;
  after: GlobalRule | null;
  actor: string | null;
  ts: number;
}

export interface GlobalRulesPreview {
  text: string;
  hash: string;
  source: "database" | "bootstrap";
  degraded: boolean;
  ruleCount: number;
}

export interface RuleEnforcementResult {
  decision: "allow" | "require_approval" | "deny";
  effectiveDecision: "allow" | "require_approval" | "deny";
  mode: "observe" | "enforce";
  hits: Array<{
    ruleId: string;
    title: string;
    category: string;
    severity: RuleSeverity;
    matchedOn: string;
  }>;
}

export type FilePreviewResponse = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  language: string | null;
  line: number | null;
};

export interface TaskQueueStatus {
  enabled: boolean;
  running: boolean;
  ready: boolean;
  streaming: boolean;
  error?: string;
}

export type TaskEventPayload =
  | { event: "task:started"; data: Task }
  | { event: "task:updated"; data: Task }
  | { event: "task:deleted"; data: { taskId: string } }
  | { event: "task:running"; data: Task }
  | { event: "task:completed"; data: Task }
  | { event: "task:cancelled"; data: Task }
  | { event: "task:failed"; data: { task: Task; error: string } }
  | { event: "message"; data: { taskId: string; role: string; content: string } }
  | { event: "message:delta"; data: { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" } }
  | { event: "command"; data: { taskId: string; command: string } };

export type TaskBundleTask = {
  externalId?: string;
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  category?: TaskCategory;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
};

export type TaskBundle = {
  version: 1;
  issueRef?: string;
  requestId?: string;
  runQueue?: boolean;
  autoApprove?: boolean;
  specRef?: string;
  insertPosition?: "front" | "back";
  tasks: TaskBundleTask[];
};

export type TaskBundleDraftStatus = "draft" | "approved" | "deleted";

export type TaskBundleDraft = {
  id: string;
  workspaceRoot: string;
  requestId: string | null;
  status: TaskBundleDraftStatus;
  bundle: TaskBundle | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  approvedTaskIds: string[];
  lastError: string | null;
  degradeReason?: string | null;
};

export type SyncEvent = {
  seq: number;
  type: string;
  eventId?: string | null;
  revision: number;
  ts: number;
  runId?: string | null;
  payload: Record<string, unknown>;
};

export type SyncEventsResponse = {
  events: SyncEvent[];
  latestSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
  truncated: boolean;
  snapshot?: Record<string, unknown> | null;
};
