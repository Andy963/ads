import type { AgentIdentifier } from "../types.js";

/** Where a session entry was discovered. Surfaced to the UI as a provenance badge. */
export type AgentSessionSource = "app_server" | "rollout_file" | "ads_link" | "claude_transcript";

export interface AgentSessionRef {
  agentId: AgentIdentifier;
  /** Provider-native id: Codex thread id, Claude session id. */
  sessionId: string;
  cwd?: string;
  /** Provider-supplied title when available, otherwise derived from the first user turn. */
  title?: string;
  preview?: string;
  messageCount?: number;
  /**
   * Real user turns, with tool results excluded. A Claude transcript stores tool
   * results as `type: "user"` records, so a raw record count overstates this by
   * two orders of magnitude on tool-heavy sessions. Only a lower bound when the
   * scan was truncated.
   */
  userTurns?: number;
  /**
   * Set only when a complete scan proved the session holds a single user turn.
   * These are throwaway one-shot sessions (an auto-continue prompt answered once)
   * and are withheld from the picker by default. Never set from a truncated scan.
   */
  singleTurn?: boolean;
  /** How many near-identical sessions were collapsed into this entry, including itself. */
  duplicateCount?: number;
  /**
   * How many provider sessions this one ADS conversation produced, including
   * this one. Above 1 means the CLI forked a new id per resumed turn and only
   * the newest fork — this entry — still holds the full context.
   */
  forkCount?: number;
  createdAt?: number;
  updatedAt: number;
  source: AgentSessionSource;
  /** True when this session is the one the active orchestrator is already attached to. */
  isCurrent?: boolean;
  /** ADS history key, present when the session was started from ADS. */
  linkedHistoryKey?: string;
}

export interface AgentSessionListQuery {
  agentId: AgentIdentifier;
  cwd: string;
  limit?: number;
  /** Include sessions recorded under other working directories. */
  includeAllCwds?: boolean;
  /** Include one-shot sessions and duplicate titles, both hidden by default. */
  includeNoise?: boolean;
  searchTerm?: string;
  /** Opaque continuation token from a previous result's `nextCursor`. */
  cursor?: string;
}

export interface AgentSessionListResult {
  items: AgentSessionRef[];
  /** Sources that failed so the UI can explain an incomplete list. */
  degraded?: string[];
  /** Entries withheld as noise, so the UI can offer to reveal them instead of silently truncating. */
  hidden?: {
    singleTurn: number;
    duplicates: number;
    /**
     * Superseded provider sessions from fork chains. Unlike the other two these
     * are never revealed: an older fork is a strictly worse resume target.
     */
    forks: number;
  };
  /** Present when more entries exist; pass back as `cursor` to continue. */
  nextCursor?: string;
}

export const DEFAULT_SESSION_LIST_LIMIT = 20;
export const MAX_SESSION_LIST_LIMIT = 100;

export function normalizeSessionListLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_LIST_LIMIT;
  }
  return Math.min(MAX_SESSION_LIST_LIMIT, Math.floor(parsed));
}

/**
 * Continuation state for a paged listing.
 *
 * Only the Codex app-server paginates natively, and its page still has to be
 * merged with ADS's own link rows and then filtered locally, so a provider
 * cursor alone cannot address a position in the list. `offset` walks the merged
 * rows of one provider page; `providerCursor` advances to the next one.
 *
 * ADS-linked rows are emitted only while `providerCursor` is absent, which is
 * what keeps them from reappearing on every page.
 */
export interface SessionListCursor {
  providerCursor?: string;
  offset: number;
}

export function encodeSessionListCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns the initial position for anything unparseable: a bad cursor should restart, not fail. */
export function decodeSessionListCursor(raw: unknown): SessionListCursor {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { offset: 0 };
  }
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<SessionListCursor>;
    const offset = Number(parsed?.offset);
    return {
      providerCursor:
        typeof parsed?.providerCursor === "string" && parsed.providerCursor ? parsed.providerCursor : undefined,
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    };
  } catch {
    return { offset: 0 };
  }
}
