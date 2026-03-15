import type { WebSocket } from "ws";

import { matchesBroadcastSessionId } from "../ws/session.js";

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
  broadcastToReviewerSession: (broadcastSessionId: string, payload: unknown) => void;
  recordToSessionHistories: (broadcastSessionId: string, entry: WebSocketHistoryEntry) => void;
  recordToReviewerHistories: (broadcastSessionId: string, entry: WebSocketHistoryEntry) => void;
};

export function createWebSocketHub(args: {
  workerHistoryStore: { add: (key: string, entry: WebSocketHistoryEntry) => void };
  reviewerHistoryStore: { add: (key: string, entry: WebSocketHistoryEntry) => void };
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
    return chat !== "planner" && chat !== "reviewer";
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

  const isReviewerBroadcastTarget = (
    broadcastSessionId: string,
    meta: { sessionId: string; chatSessionId: string; workspaceRoot?: string },
  ): boolean => {
    if (meta.chatSessionId !== "reviewer") {
      return false;
    }
    return matchesBroadcastSessionId({
      broadcastSessionId,
      connectionSessionId: meta.sessionId,
      connectionWorkspaceRoot: meta.workspaceRoot,
    });
  };

  const broadcastToSession = (broadcastSessionId: string, payload: unknown): void => {
    let encoded = "";
    try {
      encoded = JSON.stringify(payload);
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

  const broadcastToReviewerSession = (broadcastSessionId: string, payload: unknown): void => {
    let encoded = "";
    try {
      encoded = JSON.stringify(payload);
    } catch {
      return;
    }

    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (!isReviewerBroadcastTarget(broadcastSessionId, meta)) {
        continue;
      }
      safeSendText(ws, encoded);
    }
  };

  const recordToSessionHistories = (broadcastSessionId: string, entry: WebSocketHistoryEntry): void => {
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

  const recordToReviewerHistories = (broadcastSessionId: string, entry: WebSocketHistoryEntry): void => {
    const written = new Set<string>();
    for (const meta of clientMetaByWs.values()) {
      if (!isReviewerBroadcastTarget(broadcastSessionId, meta)) {
        continue;
      }
      if (written.has(meta.historyKey)) {
        continue;
      }
      written.add(meta.historyKey);
      try {
        args.reviewerHistoryStore.add(meta.historyKey, entry);
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
    broadcastToReviewerSession,
    recordToSessionHistories,
    recordToReviewerHistories,
  };
}

