import type { WebSocket } from "ws";

import { matchesBroadcastSessionId } from "../ws/session.js";
import type { SyncEventStore } from "../sync/store.js";
import { resolveSharedWorkerSyncLaneKey } from "../sync/lane.js";
import { isTransientSyncEvent } from "../sync/eventClass.js";
import { WEB_WORKER_NAMESPACE } from "./webLaneResources.js";

export type WebSocketClientMeta = {
  historyKey: string;
  sessionId: string;
  chatSessionId: string;
  connectionId: string;
  authUserId: string;
  sessionUserId: number;
  workspaceRoot?: string;
};

export type WebSocketHistoryEntry = { role: string; text: string; ts: number; kind?: string };

export type WebSocketHub = {
  clients: Set<WebSocket>;
  clientMetaByWs: Map<WebSocket, WebSocketClientMeta>;
  safeSendText: (ws: WebSocket, text: string) => void;
  safeSendJson: (ws: WebSocket, payload: unknown) => void;
  broadcastToSession: (broadcastSessionId: string, payload: unknown) => void;
  recordToSessionHistories: (broadcastSessionId: string, entry: WebSocketHistoryEntry) => void;
};

export function createWebSocketHub(args: {
  workerHistoryStore: { add: (key: string, entry: WebSocketHistoryEntry) => void };
  syncEventStore: SyncEventStore;
}): WebSocketHub {
  const WS_READY_STATE_OPEN = 1;
  const clients: Set<WebSocket> = new Set();
  const clientMetaByWs = new Map<WebSocket, WebSocketClientMeta>();

  const safeSendText = (ws: WebSocket, text: string): void => {
    if ((ws as { readyState?: number }).readyState !== WS_READY_STATE_OPEN) {
      return;
    }
    try {
      ws.send(text);
    } catch {
      // ignore
    }
  };

  const safeSendJson = (ws: WebSocket, payload: unknown): void => {
    let encoded = "";
    try {
      encoded = JSON.stringify(payload);
    } catch {
      return;
    }
    safeSendText(ws, encoded);
  };

  const isWorkerChatSession = (chatSessionId: string): boolean => {
    const chat = String(chatSessionId ?? "").trim();
    return chat !== "planner";
  };

  const isWorkerBroadcastTarget = (
    broadcastSessionId: string,
    meta: { sessionId: string; chatSessionId: string; workspaceRoot?: string },
  ): boolean => {
    if (!isWorkerChatSession(meta.chatSessionId)) return false;
    return matchesBroadcastSessionId({
      broadcastSessionId,
      connectionSessionId: meta.sessionId,
      connectionWorkspaceRoot: meta.workspaceRoot,
    });
  };

  const closeBroadcastTargets = (broadcastSessionId: string): void => {
    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (!isWorkerBroadcastTarget(broadcastSessionId, meta)) {
        continue;
      }
      try {
        ws.close(1011, "sync persistence failed");
      } catch {
        // Best-effort: affected clients will recover through their next reconnect.
      }
    }
  };

  const broadcastToSession = (broadcastSessionId: string, payload: unknown): void => {
    const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
    const eventType = String(payloadRecord?.type ?? "").trim();
    let payloadToSend = payload;
    if (payloadRecord && eventType && !isTransientSyncEvent(eventType)) {
      const seq = args.syncEventStore.append({
        namespace: WEB_WORKER_NAMESPACE,
        laneKey: resolveSharedWorkerSyncLaneKey(broadcastSessionId),
        type: eventType,
        payload: payloadRecord,
      });
      if (seq === null) {
        closeBroadcastTargets(broadcastSessionId);
        return;
      }
      payloadToSend = { ...payloadRecord, seq };
    }

    let encoded = "";
    try {
      encoded = JSON.stringify(payloadToSend);
    } catch {
      return;
    }

    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (!isWorkerBroadcastTarget(broadcastSessionId, meta)) {
        continue;
      }
      safeSendText(ws, encoded);
    }
  };

  const recordToSessionHistories = (broadcastSessionId: string, entry: WebSocketHistoryEntry): void => {
    try {
      args.workerHistoryStore.add(resolveSharedWorkerSyncLaneKey(broadcastSessionId), entry);
    } catch {
      // Keep per-user history delivery best-effort even if the shared snapshot write fails.
    }
    const written = new Set<string>();
    for (const meta of clientMetaByWs.values()) {
      if (!isWorkerBroadcastTarget(broadcastSessionId, meta)) {
        continue;
      }
      if (written.has(meta.historyKey)) {
        continue;
      }
      written.add(meta.historyKey);
      try {
        args.workerHistoryStore.add(meta.historyKey, entry);
      } catch {
        // ignore
      }
    }
  };

  return {
    clients,
    clientMetaByWs,
    safeSendText,
    safeSendJson,
    broadcastToSession,
    recordToSessionHistories,
  };
}
