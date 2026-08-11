import type { AgentEvent } from "../../codex/events.js";

/**
 * Distinguishes "the saved session id no longer exists" from every other resume
 * failure. Only this case may silently start a fresh thread — a transient
 * upstream error or a model mismatch must keep the id so the next turn can
 * reattach.
 *
 * Observed verbatim from the CLIs when resuming an id with no transcript:
 *   codex   Error: thread/resume: thread/resume failed: no rollout found for
 *           thread id 00000000-0000-4000-8000-000000000000 (code -32600)
 *   claude  No conversation found with session ID: 00000000-0000-4000-8000-000000000000
 */
export function isMissingProviderSessionError(message: string): boolean {
  const normalized = String(message ?? "").toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return (
    normalized.includes("no rollout found") ||
    normalized.includes("no conversation found") ||
    // Generic phrasings both CLIs have used for the same condition.
    /\b(thread|session|conversation)\b[^.\n]*\bnot found\b/.test(normalized) ||
    /\bnot found\b[^.\n]*\b(thread|session|conversation)\b/.test(normalized)
  );
}

export type ProviderSessionFallbackNotice = {
  agentName: string;
  previousSessionId: string;
  message: string;
};

/**
 * Emitted after a resume was abandoned and the turn restarted on a fresh
 * thread. The transport layer keys off `sessionFallback` to flag history
 * injection for the *next* turn: this turn already ran without the old
 * context, and re-sending it here would not put it back.
 */
export function createProviderSessionFallbackEvent(notice: ProviderSessionFallbackNotice): AgentEvent {
  const detail = `原会话 ${notice.previousSessionId} 已不存在，已改用新会话继续（${notice.message}）`;
  return {
    phase: "connection",
    title: "会话已失效，改用新会话",
    detail,
    timestamp: Date.now(),
    raw: { type: "error", message: detail } as AgentEvent["raw"],
    sessionFallback: {
      reason: "missing_provider_session",
      previousSessionId: notice.previousSessionId,
    },
  };
}
