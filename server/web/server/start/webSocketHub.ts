import type { WebSocket } from "ws";

import { matchesBroadcastSessionId } from "../ws/session.js";
import type { SyncEventStore } from "../sync/store.js";
import { resolveSharedWorkerSyncLaneKey } from "../sync/lane.js";
import { isTransientSyncEvent } from "../sync/eventClass.js";
import { WEB_WORKER_NAMESPACE } from "./webLaneResources.js";

export type WebSocketClientMeta = {
  historyKey: string;
  logicalHistoryKey?: string;
  laneGeneration?: number;
  sessionId: string;
  chatSessionId: string;
  connectionId: string;
  authUserId: string;
  sessionUserId: number;
  workspaceRoot?: string;
};

export type WebSocketHub = {
  clients: Set<WebSocket>;
  clientMetaByWs: Map<WebSocket, WebSocketClientMeta>;
  safeSendText: (ws: WebSocket, text: string) => void;
  safeSendJson: (ws: WebSocket, payload: unknown) => void;
  broadcastToSession: (broadcastSessionId: string, payload: unknown) => void;
};

export function createWebSocketHub(args: {
  syncEventStore: SyncEventStore;
  laneGenerationStore?: import("../sync/laneGeneration.js").WebLaneGenerationStore;
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

  const isCurrentWorkerConnection = (meta: WebSocketClientMeta): boolean => {
    const generationStore = args.laneGenerationStore;
    const logicalHistoryKey = String(meta.logicalHistoryKey ?? "").trim();
    const generation = Number(meta.laneGeneration);
    if (!generationStore || !logicalHistoryKey || !Number.isFinite(generation) || generation < 1) {
      return true;
    }
    const namespace = meta.chatSessionId === "planner" ? "web-planner" : WEB_WORKER_NAMESPACE;
    return generationStore.getGeneration(namespace, logicalHistoryKey) === Math.floor(generation);
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
      if (!isCurrentWorkerConnection(meta)) {
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
      if (!isCurrentWorkerConnection(meta)) {
        continue;
      }
      safeSendText(ws, encoded);
    }
  };

  return {
    clients,
    clientMetaByWs,
    safeSendText,
    safeSendJson,
    broadcastToSession,
  };
}
