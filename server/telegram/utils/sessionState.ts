import path from "node:path";

import type { Logger } from "../../utils/logger.js";
import type { AgentIdentifier } from "../../agents/types.js";
import { detectWorkspaceFrom } from "../../workspace/detector.js";

import type { ThreadStorage } from "./threadStorage.js";

export type SavedSessionState = {
  threadId?: string;
  cwd?: string;
  agentThreads?: Record<string, string>;
  model?: string;
  modelReasoningEffort?: string;
  activeAgentId?: AgentIdentifier;
  reviewerSnapshotId?: string;
};

export type ContextRestoreMode = "fresh" | "thread_resumed" | "history_injection";

export type ResumeState = {
  resumeThreadId?: string;
  resumeThreadIds?: Partial<Record<AgentIdentifier, string>>;
  activeAgentId?: AgentIdentifier;
  shouldInjectHistory: boolean;
  restoreMode: ContextRestoreMode;
};

export type ActiveSessionState = {
  cwd?: string;
  model?: string;
  modelReasoningEffort?: string;
  activeAgentId?: AgentIdentifier;
};

type ThreadRecord = NonNullable<ReturnType<ThreadStorage["getRecord"]>>;

function filterAgentThreads(
  agentThreads: ThreadRecord["agentThreads"],
): Partial<Record<AgentIdentifier, string>> | undefined {
  if (!agentThreads) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(agentThreads).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as Partial<Record<AgentIdentifier, string>>;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function getSavedSessionState(storage: ThreadStorage | undefined, userId: number): SavedSessionState | undefined {
  const record = storage?.getRecord(userId);
  if (!record) {
    return undefined;
  }
  return {
    threadId: record.threadId,
    cwd: record.cwd,
    agentThreads: record.agentThreads,
    model: record.model,
    modelReasoningEffort: record.modelReasoningEffort,
    activeAgentId: record.activeAgentId as AgentIdentifier | undefined,
    reviewerSnapshotId: record.reviewerSnapshotId,
  };
}

function normalizeCwd(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return path.resolve(value);
}

function isNestedCwd(parentCwd: string, childCwd: string): boolean {
  const relative = path.relative(parentCwd, childCwd);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function areSessionCwdsCompatible(savedCwd?: string, currentCwd?: string): boolean {
  const normalizedSavedCwd = normalizeCwd(savedCwd);
  const normalizedCurrentCwd = normalizeCwd(currentCwd);
  if (!normalizedSavedCwd || !normalizedCurrentCwd) {
    return true;
  }
  if (normalizedSavedCwd === normalizedCurrentCwd) {
    return true;
  }
  if (
    isNestedCwd(normalizedSavedCwd, normalizedCurrentCwd) ||
    isNestedCwd(normalizedCurrentCwd, normalizedSavedCwd)
  ) {
    return true;
  }

  const savedWorkspaceRoot = detectWorkspaceFrom(normalizedSavedCwd);
  const currentWorkspaceRoot = detectWorkspaceFrom(normalizedCurrentCwd);
  return (
    savedWorkspaceRoot === currentWorkspaceRoot &&
    (normalizedSavedCwd === savedWorkspaceRoot || normalizedCurrentCwd === currentWorkspaceRoot)
  );
}

export function resolveResumeState(args: {
  userId: number;
  resumeThread: boolean | undefined;
  storage?: ThreadStorage;
  logger: Pick<Logger, "info">;
  resumeTtlMs: number;
  currentCwd?: string;
}): ResumeState {
  if (!args.resumeThread) {
    args.logger.info(`[Continuity] user=${args.userId} restore=fresh reason=resume_not_requested`);
    return { shouldInjectHistory: false, restoreMode: "fresh" };
  }

  const record = args.storage?.getRecord(args.userId);
  const savedActiveAgentId =
    typeof record?.activeAgentId === "string" && record.activeAgentId.trim()
      ? (record.activeAgentId.trim() as AgentIdentifier)
      : undefined;
  const candidateThreadId =
    (savedActiveAgentId ? record?.agentThreads?.[savedActiveAgentId] : undefined) ??
    record?.agentThreads?.codex ??
    record?.threadId;
  const resumeThreadIds = filterAgentThreads(record?.agentThreads);
  const updatedAt = record?.updatedAt;
  const savedCwd = normalizeCwd(record?.cwd);
  const currentCwd = normalizeCwd(args.currentCwd);

  if (candidateThreadId && savedCwd && currentCwd && !areSessionCwdsCompatible(savedCwd, currentCwd)) {
    args.logger.info(
      `[Continuity] user=${args.userId} restore=fresh reason=cwd_mismatch agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId} savedCwd=${savedCwd} currentCwd=${currentCwd}`,
    );
    return {
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "fresh",
    };
  }

  if (candidateThreadId && updatedAt && args.resumeTtlMs > 0) {
    const age = Date.now() - updatedAt;
    if (age > args.resumeTtlMs) {
      args.logger.info(
        `[Continuity] user=${args.userId} restore=history_injection reason=stale_thread agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId} ageMin=${Math.round(age / 60_000)} ttlMin=${Math.round(args.resumeTtlMs / 60_000)}`,
      );
      args.storage?.setRecord(args.userId, {
        ...record,
        threadId: undefined,
        cwd: record?.cwd,
        agentThreads: { resume: candidateThreadId },
      });
      return {
        activeAgentId: savedActiveAgentId,
        shouldInjectHistory: true,
        restoreMode: "history_injection",
      };
    }
    args.logger.info(
      `[Continuity] user=${args.userId} restore=thread_resumed agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId}`,
    );
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "thread_resumed",
    };
  }

  if (candidateThreadId && !updatedAt) {
    args.logger.info(
      `[Continuity] user=${args.userId} restore=history_injection reason=missing_updated_at agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId}`,
    );
    return {
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: true,
      restoreMode: "history_injection",
    };
  }

  if (candidateThreadId) {
    args.logger.info(
      `[Continuity] user=${args.userId} restore=thread_resumed agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId}`,
    );
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "thread_resumed",
    };
  }

  args.logger.info(`[Continuity] user=${args.userId} restore=fresh reason=no_saved_thread`);
  return {
    resumeThreadIds,
    activeAgentId: savedActiveAgentId,
    shouldInjectHistory: false,
    restoreMode: "fresh",
  };
}

export function getSavedResumeThreadId(storage: ThreadStorage | undefined, userId: number): string | undefined {
  const record = storage?.getRecord(userId);
  const raw = record?.agentThreads?.resume;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

export function clearSavedResumeThreadId(storage: ThreadStorage | undefined, userId: number): void {
  if (!storage) {
    return;
  }
  const record = storage.getRecord(userId);
  if (!record?.agentThreads?.resume) {
    return;
  }
  const agentThreads = { ...(record.agentThreads ?? {}) };
  delete agentThreads.resume;
  const normalized = Object.fromEntries(
    Object.entries(agentThreads).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as Record<string, string>;

  if (
    !record.threadId &&
    Object.keys(normalized).length === 0 &&
    !record.model &&
    !record.modelReasoningEffort &&
    !record.activeAgentId &&
    !record.reviewerSnapshotId
  ) {
    storage.removeThread(userId);
    return;
  }
  storage.setRecord(userId, {
    threadId: record.threadId,
    cwd: record.cwd,
    agentThreads: normalized,
    model: record.model,
    modelReasoningEffort: record.modelReasoningEffort,
    activeAgentId: record.activeAgentId,
    reviewerSnapshotId: record.reviewerSnapshotId,
  });
}

export function buildSyncedSessionState(args: {
  storedState?: SavedSessionState;
  sessionState?: ActiveSessionState;
  userModel?: string;
  userModelReasoningEffort?: string;
  defaultModel?: string;
  cwd?: string;
  clearThreads?: boolean;
}): SavedSessionState {
  return {
    threadId: args.clearThreads ? undefined : args.storedState?.threadId,
    cwd: args.cwd ?? args.sessionState?.cwd ?? args.storedState?.cwd,
    agentThreads: args.clearThreads ? {} : { ...(args.storedState?.agentThreads ?? {}) },
    model:
      args.sessionState?.model ||
      args.userModel ||
      args.storedState?.model ||
      args.defaultModel,
    modelReasoningEffort:
      args.sessionState?.modelReasoningEffort ||
      args.userModelReasoningEffort ||
      args.storedState?.modelReasoningEffort,
    activeAgentId:
      args.sessionState?.activeAgentId ||
      args.storedState?.activeAgentId ||
      "codex",
    reviewerSnapshotId: args.storedState?.reviewerSnapshotId,
  };
}

export function buildPreservedResetState(args: {
  currentThreadId?: string | null;
  savedThreadId?: string;
  savedState?: SavedSessionState;
  cwd?: string;
}): SavedSessionState | null {
  const threadId = args.currentThreadId ?? args.savedThreadId ?? null;
  const cwd = args.cwd ?? args.savedState?.cwd;
  if (threadId) {
    return {
      ...args.savedState,
      threadId: undefined,
      cwd,
      agentThreads: { resume: threadId },
    };
  }
  if (args.savedState?.model || args.savedState?.modelReasoningEffort || args.savedState?.activeAgentId) {
    return {
      ...args.savedState,
      threadId: undefined,
      cwd,
      agentThreads: {},
    };
  }
  return null;
}
