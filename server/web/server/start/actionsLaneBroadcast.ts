import type { WebSocket } from "ws";

import type { SyncEventStore } from "../sync/store.js";
import { isTransientSyncEvent } from "../sync/eventClass.js";
import type { WebLaneGenerationStore } from "../sync/laneGeneration.js";
import type { WebSocketClientMeta } from "./webSocketHub.js";
import { WEB_ACTIONS_NAMESPACE } from "./webLaneResources.js";

export function createActionsLaneBroadcaster(args: {
  syncEventStore: Pick<SyncEventStore, "append" | "getLatestSeq">;
  laneGenerationStore: Pick<WebLaneGenerationStore, "getGeneration">;
  clientMetaByWs: Map<WebSocket, WebSocketClientMeta>;
  sendJson: (ws: WebSocket, payload: unknown) => void;
  warn: (message: string) => void;
}): (payload: unknown, logicalHistoryKey: string, projectId: string, laneGeneration: number) => void {
  return (payload, logicalHistoryKey, projectId, laneGeneration): void => {
    const logicalKey = String(logicalHistoryKey ?? "").trim();
    const targetProjectId = String(projectId ?? "").trim();
    if (!logicalKey || !targetProjectId || !Number.isInteger(laneGeneration) || laneGeneration < 1) {
      args.warn("[WebSocket][Sync] refusing unscoped Actions broadcast");
      return;
    }
    const currentGeneration = args.laneGenerationStore.getGeneration(WEB_ACTIONS_NAMESPACE, logicalKey);
    if (currentGeneration !== laneGeneration) {
      args.warn(`[WebSocket][Sync] refusing stale Actions broadcast generation=${laneGeneration} current=${currentGeneration}`);
      return;
    }
    const historyKey = laneGeneration > 1 ? `${logicalKey}:generation:${laneGeneration}` : logicalKey;
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const eventType = String(record?.type ?? "").trim();
    let framedPayload = payload;
    if (record && eventType && isTransientSyncEvent(eventType)) {
      framedPayload = { ...record, afterSeq: args.syncEventStore.getLatestSeq(WEB_ACTIONS_NAMESPACE, historyKey) };
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
        return;
      }
      framedPayload = { ...record, seq };
    }
    for (const [ws, meta] of args.clientMetaByWs.entries()) {
      if (meta.historyKey !== historyKey || (meta.logicalHistoryKey && meta.logicalHistoryKey !== logicalKey)) continue;
      if (meta.sessionId === targetProjectId) args.sendJson(ws, framedPayload);
    }
  };
}
