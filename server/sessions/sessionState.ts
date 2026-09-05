import path from "node:path";

import type { Logger } from "../utils/logger.js";
import type { AgentIdentifier } from "../agents/types.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";

import type { ThreadStorage } from "./threadStorage.js";

export type SavedSessionState = {
  threadId?: string;
  cwd?: string;
  agentThreads?: Record<string, string>;
  model?: string;
  modelReasoningEffort?: string;
  activeAgentId?: AgentIdentifier;
};

export type ContextRestoreMode = "fresh" | "thread_resumed" | "history_injection";

export type ResumeState = {
  resumeThreadId?: string;
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
    activeAgentId: record.activeAgentId === "codex" ? "codex" : undefined,
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

export function shouldClearSavedThreadsForCwdChange(savedCwd?: string, nextCwd?: string): boolean {
  return Boolean(normalizeCwd(savedCwd) && normalizeCwd(nextCwd) && !areSessionCwdsCompatible(savedCwd, nextCwd));
}

/**
 * Decide how a rebuilt session reattaches to its provider thread.
 *
 * The rule is deliberately optimistic: a saved session id is resumed whenever
 * one exists. Nothing here tries to predict whether the provider still holds
 * that session — that question is only answerable from disk, asynchronously,
 * and this function is synchronous and on the hot path. A session that really
 * did disappear surfaces as a resume error on the first turn, where the adapter
 * falls back to a fresh thread and flags history injection for the next one.
 *
 * In particular there is no idle timeout. A rollout/transcript on disk does not
 * expire, so wall-clock age is not evidence that resuming would fail; dropping
 * the thread on a timer only guaranteed the exact context loss it was meant to
 * avoid. History injection is the degraded path, not a scheduled one.
 */
export function resolveResumeState(args: {
  userId: number;
  resumeThread: boolean | undefined;
  storage?: ThreadStorage;
  logger: Pick<Logger, "info">;
  currentCwd?: string;
}): ResumeState {
  if (!args.resumeThread) {
    args.logger.info(`[Continuity] user=${args.userId} restore=fresh reason=resume_not_requested`);
    return { shouldInjectHistory: false, restoreMode: "fresh" };
  }

  const record = args.storage?.getRecord(args.userId);
  // Legacy records may still say that Claude was active. Claude session ids
  // are not valid Codex thread ids, so only the canonical Codex binding is
  // eligible for native resume after the engine consolidation.
  const savedActiveAgentId = record?.activeAgentId === "codex" ? "codex" : undefined;
  const candidateThreadId = record?.agentThreads?.codex ?? record?.threadId;
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

  if (candidateThreadId) {
    args.logger.info(
      `[Continuity] user=${args.userId} restore=thread_resumed agent=${savedActiveAgentId ?? "unknown"} thread=${candidateThreadId}`,
    );
    // The provider reloads its own transcript for this thread, so injecting the
    // ADS history on top would make the model read the same turns twice: once as
    // real context and once as a user-authored recap.
    return {
      resumeThreadId: candidateThreadId,
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: false,
      restoreMode: "thread_resumed",
    };
  }

  if (record) {
    args.logger.info(
      `[Continuity] user=${args.userId} restore=history_injection reason=saved_state_without_thread agent=${savedActiveAgentId ?? "unknown"}`,
    );
    return {
      activeAgentId: savedActiveAgentId,
      shouldInjectHistory: true,
      restoreMode: "history_injection",
    };
  }

  args.logger.info(`[Continuity] user=${args.userId} restore=fresh reason=no_saved_thread`);
  return {
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
    !record.activeAgentId
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
    activeAgentId: "codex",
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
