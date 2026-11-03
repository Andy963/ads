import type { WebSocket } from "ws";

import type { IssueVerdictStatus } from "../../../actions/reviewComment.js";
import type { SyncEventStore } from "../sync/store.js";
import type { WebLaneGenerationStore } from "../sync/laneGeneration.js";
import { buildWsConnectionIdentity } from "../ws/connectionIdentity.js";
import { ACOPILOT_CHAT_SESSION_ID } from "../ws/session.js";
import { WEB_ACOPILOT_NAMESPACE } from "./webLaneResources.js";
import type { WebSocketClientMeta } from "./webSocketHub.js";

export const REVIEW_VERDICT_READY_EVENT = "review_verdict_ready";

export interface AcopilotWakeInput {
  projectId: string;
  authUserId: string;
  issueId: number;
  prNumber?: number | null;
  status: IssueVerdictStatus;
  jobId: string;
  headSha?: string | null;
}

/**
 * `review_verdict_ready` is a durable signal, not the verdict itself. The
 * verdict lives in the Issue comment, so a dropped or replayed signal can only
 * delay the follow-up turn.
 */
export function createAcopilotLaneWaker(args: {
  syncEventStore: Pick<SyncEventStore, "append" | "getLatestSeq">;
  laneGenerationStore: Pick<WebLaneGenerationStore, "getGeneration">;
  clientMetaByWs: Map<WebSocket, WebSocketClientMeta>;
  sendJson: (ws: WebSocket, payload: unknown) => void;
  warn: (message: string) => void;
}): (input: AcopilotWakeInput) => void {
  const wokenJobs = new Set<string>();
  return (input): void => {
    const authUserId = String(input.authUserId ?? "").trim();
    const projectId = String(input.projectId ?? "").trim();
    const jobId = String(input.jobId ?? "").trim();
    if (!authUserId || !projectId || !jobId || !Number.isSafeInteger(input.issueId) || input.issueId < 1) {
      args.warn("[WebSocket][Sync] refusing unscoped Acopilot wake event");
      return;
    }
    if (wokenJobs.has(jobId)) return;
    wokenJobs.add(jobId);
    const logicalKey = buildWsConnectionIdentity({
      authUserId,
      sessionId: projectId,
      chatSessionId: ACOPILOT_CHAT_SESSION_ID,
      randomHex: () => "",
    }).historyKey;
    const generation = args.laneGenerationStore.getGeneration(WEB_ACOPILOT_NAMESPACE, logicalKey);
    const historyKey = generation > 1 ? `${logicalKey}:generation:${generation}` : logicalKey;
    const ts = Date.now();
    const payload = {
      type: REVIEW_VERDICT_READY_EVENT,
      eventId: `${REVIEW_VERDICT_READY_EVENT}:${jobId}`,
      ts,
      projectId,
      issueId: input.issueId,
      prNumber: input.prNumber ?? null,
      status: input.status,
      jobId,
      headSha: input.headSha ?? null,
    };
    const seq = args.syncEventStore.append({
      namespace: WEB_ACOPILOT_NAMESPACE,
      laneKey: historyKey,
      type: REVIEW_VERDICT_READY_EVENT,
      payload,
      eventId: payload.eventId,
      ts,
    });
    if (seq === null) {
      args.warn(`[WebSocket][Sync] refusing unlogged Acopilot wake job=${jobId} history=${historyKey}`);
      return;
    }
    const framed = { ...payload, seq };
    for (const [ws, meta] of args.clientMetaByWs.entries()) {
      if (meta.historyKey !== historyKey) continue;
      if (meta.sessionId === projectId) args.sendJson(ws, framed);
    }
  };
}
