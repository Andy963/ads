import type { WebSocket } from "ws";


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
};

export function createWebSocketHub(): WebSocketHub {
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

  return {
    clients,
    clientMetaByWs,
    safeSendText,
    safeSendJson,
  };
}
