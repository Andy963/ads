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

function normalizeGeneration(value: number | undefined): number {
  const generation = Number(value);
  return Number.isFinite(generation) && generation >= 1 ? Math.floor(generation) : 0;
}

export function buildWsConnectionIdentity(args: {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  connectionId?: string;
  randomHex?: (bytes: number) => string;
  generation?: number;
}): WsConnectionIdentity {
  const authUserId = String(args.authUserId ?? "").trim();
  const sessionId = String(args.sessionId ?? "").trim();
  const chatSessionId = String(args.chatSessionId ?? "").trim();
  const chatKey = `${sessionId}:${chatSessionId}`;
  const legacyUserId = deriveLegacyWebUserId(authUserId, chatKey);
  const generation = normalizeGeneration(args.generation);
  // Generation one keeps the pre-isolation key shape so an upgrade does not
  // make existing lane history and thread state appear to vanish. A reset
  // advances to generation two, which is the first fenced storage namespace.
  const generationSuffix = generation > 1 ? `:generation:${generation}` : "";
  const storageChatKey = `${chatKey}${generationSuffix}`;
  const userId = deriveWebUserId(authUserId, storageChatKey);
  const historyKey = `${authUserId}::${sessionId}::${chatSessionId}${generationSuffix}`;
  const connectionId =
    String(args.connectionId ?? "").trim() || (args.randomHex ?? ((bytes) => crypto.randomBytes(bytes).toString("hex")))(3);
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
      ...(generation > 0 ? { laneGeneration: generation } : {}),
    },
  };
}
