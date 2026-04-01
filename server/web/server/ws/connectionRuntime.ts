import type { WebSocket } from "ws";

import type { WsClientMeta, WsLogger } from "./deps.js";
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
  historyKey: string;
}): boolean {
  const controller = args.interruptControllers.get(args.historyKey);
  if (!controller) {
    return false;
  }
  try {
    controller.abort();
  } catch {
    // ignore
  }
  return true;
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
  logger: WsLogger;
}): void {
  args.clients.delete(args.ws);
  const meta = args.clientMetaByWs.get(args.ws);
  if (meta?.historyKey) {
    const controller = args.interruptControllers.get(meta.historyKey);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      args.interruptControllers.delete(meta.historyKey);
    }
  }
  args.clientMetaByWs.delete(args.ws);
  const reasonText = formatCloseReason(args.reason);
  const suffix = reasonText ? ` reason=${reasonText}` : "";
  args.logger.info(
    `client disconnected conn=${meta?.connectionId ?? "unknown"} session=${args.sessionId} user=${args.userId} history=${meta?.historyKey ?? ""} code=${args.code}${suffix}`,
  );
}
