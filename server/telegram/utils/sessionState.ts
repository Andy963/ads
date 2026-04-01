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
};

export type ResumeState = {
  resumeThreadId?: string;
  resumeThreadIds?: Partial<Record<AgentIdentifier, string>>;
  activeAgentId?: AgentIdentifier;
  shouldInjectHistory: boolean;
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
  };
}

export function resolveResumeState(args: {
  userId: number;
  resumeThread: boolean | undefined;
  storage?: ThreadStorage;
  logger: Pick<Logger, "info">;
  resumeTtlMs: number;
}): ResumeState {
  if (!args.resumeThread) {
    return { shouldInjectHistory: false };
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
      };
    }
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
    };
  }

  if (candidateThreadId && !updatedAt) {
    args.logger.info("Thread has no updatedAt, treating as stale — will inject history instead");
    return {
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: true,
    };
  }

  if (candidateThreadId) {
    return {
      resumeThreadId: candidateThreadId,
      resumeThreadIds,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
    };
  }

  return {
    resumeThreadIds,
    activeAgentId: savedActiveAgentId,
    shouldInjectHistory: false,
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

  if (!record.threadId && Object.keys(normalized).length === 0 && !record.model && !record.modelReasoningEffort && !record.activeAgentId) {
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
