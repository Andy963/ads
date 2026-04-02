export type TaskResumeMode = "auto" | "current" | "saved";

export type TaskResumeRequest = {
  mode: TaskResumeMode;
  threadId?: string;
};

export type TaskResumeSelection = {
  threadId: string;
  source: "none" | "explicit" | "current" | "saved";
};

const PERMANENT_TASK_RESUME_FAILURE_PATTERNS = [
  /\bnot\s+found\b/i,
  /\bno\s+such\b/i,
  /\bdoes\s+not\s+exist\b/i,
  /\bunknown\b/i,
  /\binvalid\b/i,
  /\bmalformed\b/i,
  /\bmissing\b/i,
];

function normalizeMode(value: unknown): TaskResumeMode {
  if (typeof value !== "string") {
    return "auto";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  if (normalized === "current") {
    return "current";
  }
  if (normalized === "saved" || normalized === "resume") {
    return "saved";
  }
  return "auto";
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseTaskResumeRequest(payload: unknown): TaskResumeRequest {
  if (!payload || typeof payload !== "object") {
    return { mode: "auto" };
  }

  const record = payload as Record<string, unknown>;
  const mode = normalizeMode(record.mode ?? record.prefer ?? record.source);
  const threadId =
    normalizeThreadId(record.threadId) ??
    normalizeThreadId(record.thread_id) ??
    normalizeThreadId(record.thread);

  return threadId ? { mode, threadId } : { mode };
}

export function selectTaskResumeThread(args: {
  request: TaskResumeRequest;
  currentThreadId: string | null;
  savedThreadId?: string;
  savedResumeThreadId?: string;
  canResumeThread?: boolean;
}): TaskResumeSelection {
  const explicitThreadId = String(args.request.threadId ?? "").trim();
  if (explicitThreadId) {
    return { threadId: explicitThreadId, source: "explicit" };
  }

  const currentThreadId = String(args.currentThreadId ?? "").trim();
  const savedThreadId = String(args.savedThreadId ?? "").trim();
  const savedResumeThreadId = String(args.savedResumeThreadId ?? "").trim();

  const mode = args.request.mode ?? "auto";
  if (args.canResumeThread === false) {
    return { threadId: "", source: "none" };
  }

  if (mode === "saved") {
    if (savedResumeThreadId) {
      return { threadId: savedResumeThreadId, source: "saved" };
    }
    if (currentThreadId) {
      return { threadId: currentThreadId, source: "current" };
    }
    if (savedThreadId) {
      return { threadId: savedThreadId, source: "current" };
    }
    return { threadId: "", source: "none" };
  }

  if (mode === "current") {
    if (currentThreadId) {
      return { threadId: currentThreadId, source: "current" };
    }
    if (savedThreadId) {
      return { threadId: savedThreadId, source: "current" };
    }
    return { threadId: "", source: "none" };
  }

  if (currentThreadId) {
    return { threadId: currentThreadId, source: "current" };
  }
  if (savedThreadId) {
    return { threadId: savedThreadId, source: "current" };
  }
  if (savedResumeThreadId) {
    return { threadId: savedResumeThreadId, source: "saved" };
  }
  return { threadId: "", source: "none" };
}

export function isPermanentTaskResumeFailure(message: unknown): boolean {
  const normalized = String(message ?? "").trim();
  if (!normalized) {
    return false;
  }
  return PERMANENT_TASK_RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}
