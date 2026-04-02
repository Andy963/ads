import type { WebSocket } from "ws";

import type { WsClientMeta, WsLogger } from "./deps.js";
import { invalidateWsPromptRun } from "./promptLifecycle.js";
import { formatCloseReason } from "./utils.js";

export function broadcastJsonToHistoryKey(args: {
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  historyKey: string;
  payload: unknown;
  sendJson: (ws: WebSocket, payload: unknown) => void;
}): void {
  for (const [candidate, meta] of args.clientMetaByWs.entries()) {
    if (meta.historyKey !== args.historyKey) {
      continue;
    }
    args.sendJson(candidate, args.payload);
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
  const hasSiblingForHistory =
    typeof meta?.historyKey === "string" &&
    Array.from(args.clientMetaByWs.entries()).some(
      ([candidate, candidateMeta]) => candidate !== args.ws && candidateMeta?.historyKey === meta.historyKey,
    );
  if (meta?.historyKey && !hasSiblingForHistory) {
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
    `client disconnected conn=${meta?.connectionId ?? "unknown"} session=${args.sessionId} user=${args.userId} history=${meta?.historyKey ?? ""} code=${args.code}${suffix}`,
  );
}
