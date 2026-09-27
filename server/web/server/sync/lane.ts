import { buildWsConnectionIdentity } from "../ws/connectionIdentity.js";
import { isAcopilotChatSessionId } from "../ws/session.js";
import { WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE } from "../start/webLaneResources.js";

export function resolveSyncNamespace(chatSessionId: string): string {
  return isAcopilotChatSessionId(chatSessionId) ? WEB_ACOPILOT_NAMESPACE : WEB_ACTIONS_NAMESPACE;
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

export function resolveSyncLaneKeys(args: {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  generation?: number;
}): string[] {
  return [resolveSyncLaneKey(args)];
}
