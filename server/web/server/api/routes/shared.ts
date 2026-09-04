import type { ServerResponse } from "node:http";

import type { ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";

export type ResolvedWorkspaceContext = ReturnType<ApiSharedDeps["resolveWorkspaceContext"]>;

export function resolveWorkspaceContextOrSendBadRequest(
  deps: Pick<ApiSharedDeps, "resolveWorkspaceContext">,
  url: URL,
  res: ServerResponse,
): ResolvedWorkspaceContext | null {
  try {
    return deps.resolveWorkspaceContext(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
    return null;
  }
}
