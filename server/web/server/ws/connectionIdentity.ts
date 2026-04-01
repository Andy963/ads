import crypto from "node:crypto";

import { deriveLegacyWebUserId, deriveWebUserId } from "../../utils.js";
import type { WsClientMeta } from "./deps.js";

export type WsConnectionIdentity = {
  authUserId: string;
  chatKey: string;
  legacyUserId: number;
  userId: number;
  historyKey: string;
  connectionId: string;
  cacheKey: string;
  clientMeta: WsClientMeta;
};

export function buildWsConnectionIdentity(args: {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  randomHex?: (bytes: number) => string;
}): WsConnectionIdentity {
  const authUserId = String(args.authUserId ?? "").trim();
  const sessionId = String(args.sessionId ?? "").trim();
  const chatSessionId = String(args.chatSessionId ?? "").trim();
  const chatKey = `${sessionId}:${chatSessionId}`;
  const legacyUserId = deriveLegacyWebUserId(authUserId, chatKey);
  const userId = deriveWebUserId(authUserId, chatKey);
  const historyKey = `${authUserId}::${sessionId}::${chatSessionId}`;
  const connectionId = (args.randomHex ?? ((bytes) => crypto.randomBytes(bytes).toString("hex")))(3);
  const cacheKey = `${authUserId}::${sessionId}`;

  return {
    authUserId,
    chatKey,
    legacyUserId,
    userId,
    historyKey,
    connectionId,
    cacheKey,
    clientMeta: {
      historyKey,
      sessionId,
      chatSessionId,
      connectionId,
      authUserId,
      sessionUserId: userId,
    },
  };
}
