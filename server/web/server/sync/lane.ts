import { buildWsConnectionIdentity } from "../ws/connectionIdentity.js";
import { WEB_PLANNER_NAMESPACE, WEB_WORKER_NAMESPACE } from "../start/webLaneResources.js";

export function resolveSyncNamespace(chatSessionId: string): string {
  return String(chatSessionId ?? "").trim() === "planner" ? WEB_PLANNER_NAMESPACE : WEB_WORKER_NAMESPACE;
}

export function resolveSyncLaneKey(args: {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  generation?: number;
}): string {
  return buildWsConnectionIdentity({
    authUserId: args.authUserId,
    sessionId: args.sessionId,
    chatSessionId: args.chatSessionId,
    generation: args.generation,
    randomHex: () => "",
  }).historyKey;
}

export function resolveSharedWorkerSyncLaneKey(sessionId: string): string {
  return `shared::${String(sessionId ?? "").trim()}`;
}

export function resolveSyncLaneKeys(args: {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  generation?: number;
}): string[] {
  return [resolveSyncLaneKey(args)];
}
