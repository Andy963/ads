import { deriveProjectSessionId } from "../projectSessionId.js";
import { normalizeRequestedSessionId } from "../ws/session.js";
import { resolveSyncLaneKey, resolveSyncLaneKeys, resolveSyncNamespace } from "./lane.js";

export type ResolvedLaneRequest = {
  sessionId: string;
  chatSessionId: string;
  namespace: string;
  /** The caller's own lane. Also the historyKey an in-flight run is registered under. */
  laneKey: string;
  /** Every lane the caller may read from (own lane plus the shared worker lane). */
  laneKeys: string[];
};

export type LaneRequestFailure = { status: number; error: string };

/**
 * Resolve the sync lane a request addresses.
 *
 * Lane identity is derived server-side from the authenticated user plus the
 * workspace-validated session id — never taken from the client — so a caller
 * cannot read or interrupt another user's lane by naming its key.
 */
export function resolveLaneRequest(args: {
  url: URL;
  authUserId: string;
  defaultWorkspaceRoot: string;
  resolveWorkspaceRoot: (url: URL) => string;
}): { ok: true; lane: ResolvedLaneRequest } | { ok: false; failure: LaneRequestFailure } {
  const requestedSessionId = String(args.url.searchParams.get("sessionId") ?? "").trim();
  const chatSessionId = String(args.url.searchParams.get("chatSessionId") ?? "main").trim() || "main";
  if (!requestedSessionId) {
    return { ok: false, failure: { status: 400, error: "sessionId is required" } };
  }

  let workspaceRoot = "";
  try {
    workspaceRoot = requestedSessionId === "default"
      ? args.defaultWorkspaceRoot
      : args.resolveWorkspaceRoot(args.url);
  } catch (error) {
    return {
      ok: false,
      failure: { status: 400, error: error instanceof Error ? error.message : String(error) },
    };
  }

  const sessionId = normalizeRequestedSessionId({ requestedSessionId, workspaceRoot });
  const expectedSessionId = deriveProjectSessionId(workspaceRoot);
  if (sessionId !== expectedSessionId) {
    return { ok: false, failure: { status: 400, error: "sessionId does not match workspace" } };
  }

  const identity = { authUserId: args.authUserId, sessionId, chatSessionId };
  return {
    ok: true,
    lane: {
      sessionId,
      chatSessionId,
      namespace: resolveSyncNamespace(chatSessionId),
      laneKey: resolveSyncLaneKey(identity),
      laneKeys: resolveSyncLaneKeys(identity),
    },
  };
}
