import path from "node:path";

import type { Logger } from "../../utils/logger.js";
import type { AgentIdentifier } from "../../agents/types.js";

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

export function resolveResumeState(args: {
  userId: number;
  resumeThread: boolean | undefined;
  storage?: ThreadStorage;
  logger: Pick<Logger, "info">;
  resumeTtlMs: number;
  currentCwd?: string;
}): ResumeState {
  if (!args.resumeThread) {
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
  const savedCwd = typeof record?.cwd === "string" && record.cwd.trim() ? path.resolve(record.cwd) : undefined;
  const currentCwd =
    typeof args.currentCwd === "string" && args.currentCwd.trim() ? path.resolve(args.currentCwd) : undefined;

  if (candidateThreadId && savedCwd && currentCwd && savedCwd !== currentCwd) {
    args.logger.info(
      `Skipping auto-resume because saved cwd no longer matches current cwd (saved=${savedCwd} current=${currentCwd})`,
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
        `Thread too stale for auto-resume (age=${Math.round(age / 60_000)}min ttl=${Math.round(args.resumeTtlMs / 60_000)}min), will inject history instead`,
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
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "thread_resumed",
    };
  }

  if (candidateThreadId && !updatedAt) {
    args.logger.info("Thread has no updatedAt, treating as stale — will inject history instead");
    return {
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: true,
      restoreMode: "history_injection",
    };
  }

  if (candidateThreadId) {
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "thread_resumed",
    };
  }

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
