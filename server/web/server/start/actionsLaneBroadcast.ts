import type { WebSocket } from "ws";

import type { SyncEventStore } from "../sync/store.js";
import { isTransientSyncEvent } from "../sync/eventClass.js";
import { WEB_ACTIONS_NAMESPACE } from "./webLaneResources.js";
import type { WebLaneGenerationStore } from "../sync/laneGeneration.js";
import type { WebSocketClientMeta } from "./webSocketHub.js";

export function createActionsLaneBroadcaster(args: {
  syncEventStore: Pick<SyncEventStore, "append" | "getLatestSeq">;
  laneGenerationStore: Pick<WebLaneGenerationStore, "getGeneration">;
  clientMetaByWs: Map<WebSocket, WebSocketClientMeta>;
  sendJson: (ws: WebSocket, payload: unknown) => void;
  warn: (message: string) => void;
}): (payload: unknown, logicalHistoryKey?: string, projectId?: string) => void {
  return (payload, logicalHistoryKey, projectId): void => {
    const logicalKey = String(logicalHistoryKey ?? "").trim();
    if (!logicalKey) return;

    const generation = args.laneGenerationStore.getGeneration(WEB_ACTIONS_NAMESPACE, logicalKey);
    const historyKey = generation > 1 ? `${logicalKey}:generation:${generation}` : logicalKey;
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const eventType = String(record?.type ?? "").trim();
    let framedPayload = payload;

    if (record && eventType && isTransientSyncEvent(eventType)) {
      framedPayload = {
        ...record,
        afterSeq: args.syncEventStore.getLatestSeq(WEB_ACTIONS_NAMESPACE, historyKey),
      };
    } else if (record && eventType) {
      const eventTs = Number(record.ts ?? record.timestamp);
      const eventId = String(record.eventId ?? record.event_id ?? "").trim() || undefined;
      const replayPayload = { ...record };
      delete replayPayload.raw;
      const seq = args.syncEventStore.append({
        namespace: WEB_ACTIONS_NAMESPACE,
        laneKey: historyKey,
        type: eventType,
        payload: replayPayload,
        eventId,
        ts: Number.isFinite(eventTs) && eventTs > 0 ? eventTs : undefined,
      });
      if (seq === null) {
        args.warn(`[WebSocket][Sync] refusing unlogged Actions event type=${eventType} history=${historyKey}`);
      } else {
        framedPayload = { ...record, seq };
      }
    }

    for (const [ws, meta] of args.clientMetaByWs.entries()) {
      if (meta.historyKey !== historyKey) continue;
      if (meta.logicalHistoryKey && meta.logicalHistoryKey !== logicalKey) continue;
      if (projectId && meta.sessionId !== projectId) continue;
      args.sendJson(ws, framedPayload);
    }
  };
}
