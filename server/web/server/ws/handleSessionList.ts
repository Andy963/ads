import { listAgentSessions } from "../../../agents/sessions/catalog.js";
import type { AgentIdentifier } from "../../../agents/types.js";
import { normalizeSessionListLimit } from "../../../agents/sessions/types.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { truncateForLog } from "../../utils.js";

export interface SessionListRequest {
  agentId?: string;
  limit?: number;
  search?: string;
  includeAllCwds?: boolean;
  includeNoise?: boolean;
  cursor?: string;
}

export function parseSessionListRequest(payload: unknown): SessionListRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  const search = typeof record.search === "string" ? record.search.trim() : "";
  const cursor = typeof record.cursor === "string" ? record.cursor.trim() : "";
  return {
    agentId: agentId || undefined,
    limit: normalizeSessionListLimit(record.limit),
    search: search || undefined,
    includeAllCwds: record.includeAllCwds === true,
    includeNoise: record.includeNoise === true,
    cursor: cursor || undefined,
  };
}

/**
 * Answer a `session_list` request with the resumable sessions for the active
 * agent in the current working directory. Read-only: it never spawns a turn and
 * never mutates saved session state.
 */
export async function handleSessionListMessage(args: {
  payload: unknown;
  historyStore: HistoryStore;
  currentCwd: string;
  activeAgentId: AgentIdentifier;
  currentSessionId?: string | null;
  sendJson: (payload: unknown) => void;
  logger: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<void> {
  const request = parseSessionListRequest(args.payload);
  const agentId = (request.agentId ?? args.activeAgentId) as AgentIdentifier;

  try {
    const result = await listAgentSessions(
      { historyStore: args.historyStore, currentSessionId: args.currentSessionId },
      {
        agentId,
        cwd: args.currentCwd,
        limit: request.limit,
        searchTerm: request.search,
        includeAllCwds: request.includeAllCwds,
        includeNoise: request.includeNoise,
        cursor: request.cursor,
      },
    );
    args.logger.info(
      `[Web][session_list] agent=${agentId} cwd=${args.currentCwd} items=${result.items.length} hidden=${(result.hidden?.singleTurn ?? 0) + (result.hidden?.duplicates ?? 0)} more=${result.nextCursor ? "yes" : "no"} degraded=${result.degraded?.join(",") ?? "none"}`,
    );
    args.sendJson({
      type: "session_list_result",
      agentId,
      cwd: args.currentCwd,
      items: result.items,
      degraded: result.degraded,
      hidden: result.hidden,
      nextCursor: result.nextCursor,
      // Echoed so the client can tell an appended page from a fresh list.
      appended: Boolean(request.cursor),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(`[Web][session_list] failed agent=${agentId} err=${truncateForLog(message)}`);
    args.sendJson({
      type: "session_list_result",
      agentId,
      cwd: args.currentCwd,
      items: [],
      error: message,
      appended: Boolean(request.cursor),
    });
  }
}
