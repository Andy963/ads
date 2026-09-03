import type { WebSocket } from "ws";

import type { WsClientMeta, WsLogger } from "./deps.js";
import { invalidateWsPromptRun } from "./promptLifecycle.js";
import { formatCloseReason } from "./utils.js";

export function broadcastJsonToHistoryKey(args: {
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  historyKey: string;
  logicalHistoryKey?: string;
  laneGeneration?: number;
  payload: unknown;
  sendJson: (ws: WebSocket, payload: unknown) => void;
  excludeWs?: WebSocket;
}): void {
  for (const [candidate, meta] of args.clientMetaByWs.entries()) {
    if (args.excludeWs && candidate === args.excludeWs) {
      continue;
    }
    if (meta.historyKey !== args.historyKey) {
      continue;
    }
    if (args.logicalHistoryKey && meta.logicalHistoryKey && meta.logicalHistoryKey !== args.logicalHistoryKey) {
      continue;
    }
    if (
      typeof args.laneGeneration === "number" &&
      typeof meta.laneGeneration === "number" &&
      meta.laneGeneration !== args.laneGeneration
    ) {
      continue;
    }
    args.sendJson(candidate, args.payload);
  }
}

export function closeConnectionsForHistoryKey(args: {
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  historyKey: string;
  code?: number;
  reason?: string;
}): void {
  const code = args.code ?? 1011;
  const reason = args.reason ?? "sync persistence failed";
  for (const [candidate, meta] of args.clientMetaByWs.entries()) {
    if (meta.historyKey !== args.historyKey) {
      continue;
    }
    try {
      candidate.close(code, reason);
    } catch {
      // Best-effort: reconnect recovery only needs at least one close attempt.
    }
  }
}

export function closeConnectionsForLogicalLane(args: {
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  logicalHistoryKey: string;
  authUserId?: string;
  sessionId?: string;
  chatSessionId?: string;
  code?: number;
  reason?: string;
}): void {
  const logicalHistoryKey = String(args.logicalHistoryKey ?? "").trim();
  if (!logicalHistoryKey) {
    return;
  }
  const code = args.code ?? 1012;
  const reason = args.reason ?? "session reset";
  for (const [candidate, meta] of args.clientMetaByWs.entries()) {
    if ((meta.logicalHistoryKey ?? meta.historyKey) !== logicalHistoryKey) {
      continue;
    }
    if (args.authUserId && meta.authUserId !== args.authUserId) {
      continue;
    }
    if (args.sessionId && meta.sessionId !== args.sessionId) {
      continue;
    }
    if (args.chatSessionId && meta.chatSessionId !== args.chatSessionId) {
      continue;
    }
    try {
      candidate.close(code, reason);
    } catch {
      // Best-effort: reconnect recovery only needs a close attempt.
    }
  }
}

export function closeConnectionsForSession(args: {
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  authUserId: string;
  sessionId: string;
  code?: number;
  reason?: string;
}): void {
  const code = args.code ?? 1011;
  const reason = args.reason ?? "sync persistence failed";
  for (const [candidate, meta] of args.clientMetaByWs.entries()) {
    if (meta.authUserId !== args.authUserId || meta.sessionId !== args.sessionId) {
      continue;
    }
    try {
      candidate.close(code, reason);
    } catch {
      // Best-effort: every affected lane gets its own reconnect opportunity.
    }
  }
}

export function abortInFlightHistory(args: {
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  historyKey: string;
}): boolean {
  return invalidateWsPromptRun({
    historyKey: args.historyKey,
    interruptControllers: args.interruptControllers,
    promptRunEpochs: args.promptRunEpochs,
  });
}

export function cleanupClosedConnection(args: {
  ws: WebSocket;
  code: number;
  reason: Buffer;
  sessionId: string;
  userId: number;
  clients: Set<WebSocket>;
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  logger: WsLogger;
}): void {
  args.clients.delete(args.ws);
  const meta = args.clientMetaByWs.get(args.ws);
  const inFlight = Boolean(meta?.historyKey && args.interruptControllers.has(meta.historyKey));
  const hasSiblingConnection = Boolean(
    meta?.historyKey &&
    [...args.clientMetaByWs.entries()].some(
      ([candidate, candidateMeta]) =>
        candidate !== args.ws && args.clients.has(candidate) && candidateMeta.historyKey === meta.historyKey,
    ),
  );
  if (args.code === 4401 && inFlight && !hasSiblingConnection && meta?.historyKey) {
    invalidateWsPromptRun({
      historyKey: meta.historyKey,
      interruptControllers: args.interruptControllers,
      promptRunEpochs: args.promptRunEpochs,
    });
  }
  args.clientMetaByWs.delete(args.ws);
  const reasonText = formatCloseReason(args.reason);
  const suffix = reasonText ? ` reason=${reasonText}` : "";
  args.logger.info(
    `client disconnected conn=${meta?.connectionId ?? "unknown"} session=${args.sessionId} user=${args.userId} history=${meta?.historyKey ?? ""} code=${args.code}${suffix} inFlight=${inFlight}`,
  );
}
