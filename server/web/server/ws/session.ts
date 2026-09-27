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
 * Canonical chat session id for the Acopilot lane (ADR 0027).
 *
 * This value is embedded in persisted keys: `buildWsConnectionIdentity`
 * derives `historyKey` as `<authUserId>::<sessionId>::<chatSessionId>`, and the
 * sync cursor, thread state and lane generation rows are keyed from the same
 * pair. Schema migration 26 moves existing rows onto this spelling.
 */
export const ACOPILOT_CHAT_SESSION_ID = "acopilot";
/** Retired lane id. Accepted from older clients and mapped to the canonical id. */
export const LEGACY_ADVISOR_CHAT_SESSION_ID = "advisor";
/** Retired lane id from the pre-advisor era. Accepted and mapped the same way. */
export const LEGACY_PLANNER_CHAT_SESSION_ID = "planner";

/**
 * Single boundary that resolves any accepted Acopilot-lane spelling to the
 * canonical chat session id. `acopilot`, `advisor` and `planner` all land on
 * ACOPILOT_CHAT_SESSION_ID; every other value, including the Actions lane's own
 * project session ids and "main", passes through untouched so it keeps routing
 * to Actions.
 */
export function normalizeLaneChatSessionId(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (
    normalized === LEGACY_ADVISOR_CHAT_SESSION_ID
    || normalized === LEGACY_PLANNER_CHAT_SESSION_ID
    || normalized === ACOPILOT_CHAT_SESSION_ID
  ) {
    return ACOPILOT_CHAT_SESSION_ID;
  }
  return normalized;
}

/** True when the chat session id addresses the Acopilot lane, in any accepted spelling. */
export function isAcopilotChatSessionId(value: string | null | undefined): boolean {
  return normalizeLaneChatSessionId(value) === ACOPILOT_CHAT_SESSION_ID;
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
