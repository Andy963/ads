import crypto from "node:crypto";

import { deriveProjectSessionId } from "../projectSessionId.js";

function parseProtocolToken(protocols: string[], tokenName: string): string | null {
  const dotPrefix = `${tokenName}.`;
  const colonPrefix = `${tokenName}:`;
  for (let i = 0; i < protocols.length; i++) {
    const entry = protocols[i] ?? "";
    if (entry.startsWith(dotPrefix)) {
      return entry.slice(dotPrefix.length).trim() || null;
    }
    if (entry.startsWith(colonPrefix)) {
      return entry.slice(colonPrefix.length).trim() || null;
    }
    if (entry === tokenName && i + 1 < protocols.length) {
      const next = protocols[i + 1] ?? "";
      return String(next).trim() || null;
    }
  }
  return null;
}

export function parseWsSessionFromProtocols(protocols: string[]): string | null {
  return parseProtocolToken(protocols, "ads-session");
}

export function parseWsChatSessionFromProtocols(protocols: string[]): string | null {
  return parseProtocolToken(protocols, "ads-chat");
}

export function normalizeRequestedSessionId(args: {
  requestedSessionId: string;
  workspaceRoot: string;
}): string {
  const requested = String(args.requestedSessionId ?? "").trim();
  return requested === "default" ? deriveProjectSessionId(args.workspaceRoot) : requested;
}

export function resolveWebSocketSessionId(args: { protocols: string[]; workspaceRoot: string }): string {
  const requested = parseWsSessionFromProtocols(args.protocols);
  if (requested) {
    return normalizeRequestedSessionId({
      requestedSessionId: requested,
      workspaceRoot: args.workspaceRoot,
    });
  }
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Stable internal chat session id for the Acopilot lane.
 *
 * This value is embedded in persisted keys -- `buildWsConnectionIdentity`
 * derives `historyKey` as `<authUserId>::<sessionId>::<chatSessionId>` and the
 * sync cursor key from the same pair -- and the client re-keys its localStorage
 * model/effort preferences by the chat session id echoed back in server frames.
 * It therefore must NOT change: doing so would orphan every existing lane
 * history, thread state and preference entry. It is a persisted key, not a
 * canonical value.
 */
export const ADVISOR_CHAT_SESSION_ID = "advisor";
/** Pre-rename lane id. Accepted from legacy clients and mapped to the advisor id. */
export const LEGACY_ADVISOR_CHAT_SESSION_ID = "planner";
/**
 * Canonical lane id (ADR 0027). Accepted from clients and mapped to the
 * advisor id so routing and persisted keys stay stable.
 */
export const CANONICAL_ACOPILOT_CHAT_SESSION_ID = "acopilot";

/**
 * Single boundary that resolves any accepted Acopilot-lane spelling to the
 * stable advisor chat session id. Both the canonical `acopilot` and the legacy
 * `advisor` / `planner` spellings land on ADVISOR_CHAT_SESSION_ID; every other
 * value (including the Actions lane's own project session ids and "main")
 * passes through untouched so it keeps routing to Actions.
 */
export function normalizeLaneChatSessionId(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (normalized === LEGACY_ADVISOR_CHAT_SESSION_ID || normalized === CANONICAL_ACOPILOT_CHAT_SESSION_ID) {
    return ADVISOR_CHAT_SESSION_ID;
  }
  return normalized;
}

/** True when the chat session id addresses the Acopilot lane, in any accepted spelling. */
export function isAcopilotChatSessionId(value: string | null | undefined): boolean {
  return normalizeLaneChatSessionId(value) === ADVISOR_CHAT_SESSION_ID;
}

export function resolveWebSocketChatSessionId(args: { protocols: string[] }): string {
  const requested = parseWsChatSessionFromProtocols(args.protocols);
  const normalized = normalizeLaneChatSessionId(requested);
  return normalized || "main";
}

export function matchesBroadcastSessionId(args: {
  broadcastSessionId: string;
  connectionSessionId: string;
  connectionWorkspaceRoot?: string | null;
}): boolean {
  const broadcastSessionId = String(args.broadcastSessionId ?? "").trim();
  if (!broadcastSessionId) return false;

  const connectionSessionId = String(args.connectionSessionId ?? "").trim();
  if (connectionSessionId === broadcastSessionId) return true;

  const workspaceRoot = String(args.connectionWorkspaceRoot ?? "").trim();
  if (!workspaceRoot) return false;
  return deriveProjectSessionId(workspaceRoot) === broadcastSessionId;
}
