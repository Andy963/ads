import fsp from "node:fs/promises";
import path from "node:path";

import type { Thread } from "../../codex/appServer/protocol/v2/Thread.js";
import type { ThreadListParams } from "../../codex/appServer/protocol/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../../codex/appServer/protocol/v2/ThreadListResponse.js";
import { getSharedDaemonRegistry } from "../../codex/appServer/daemonRegistry.js";
import { createLogger } from "../../utils/logger.js";

import { buildSessionTitle, extractUserFacingPrompt, truncatePreview } from "./promptPreview.js";
import { codexSessionsRoot, listRecentFiles } from "./sessionPaths.js";
import type { AgentSessionRef } from "./types.js";

const logger = createLogger("CodexSessionSource");

/** Rollout scans are bounded so a long-lived Codex home cannot stall the picker. */
const ROLLOUT_SCAN_LIMIT = 200;
/** Only the head of a rollout is read; session metadata and the first turn live there. */
const ROLLOUT_HEAD_BYTES = 256 * 1024;
const APP_SERVER_TIMEOUT_MS = 10_000;
/**
 * Starting the daemon is bounded separately from the request. `getOrStart` never
 * rejects on a stalled handshake, so without this the whole call hangs and the
 * rollout-file fallback below is unreachable.
 */
const APP_SERVER_START_TIMEOUT_MS = 8_000;
/** Upper bound on one app-server page; the caller filters by cwd afterwards. */
const APP_SERVER_PAGE_CAP = 200;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function toMillis(unixSeconds: number | null | undefined): number | undefined {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return undefined;
  }
  return Math.round(unixSeconds * 1000);
}

function threadToRef(thread: Thread): AgentSessionRef {
  const title = buildSessionTitle([thread.name, thread.preview]);
  return {
    agentId: "codex",
    sessionId: thread.id,
    cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
    title: title || undefined,
    preview: truncatePreview(extractUserFacingPrompt(thread.preview ?? "")) || undefined,
    createdAt: toMillis(thread.createdAt),
    updatedAt: toMillis(thread.updatedAt) ?? 0,
    source: "app_server",
  };
}

/**
 * Primary source. `useStateDbOnly` skips the JSONL scan-and-repair pass: the
 * picker only needs titles and timestamps, and the latency difference is large
 * on a big session history.
 *
 * `cwd` is deliberately NOT sent to app-server. That filter is an exact string
 * match, while ADS threads are routinely recorded under the workspace root
 * (`/repo`) even when the session runs in a subdirectory (`/repo/pkg`) — a
 * strict match returns nothing. The caller filters with
 * `areSessionCwdsCompatible`, so a wider page is fetched instead.
 */
export async function listCodexSessionsViaAppServer(args: {
  cwd: string;
  limit: number;
  searchTerm?: string;
  cursor?: string;
}): Promise<{ items: AgentSessionRef[]; nextCursor?: string }> {
  const registry = getSharedDaemonRegistry();
  const client = await withTimeout(
    registry.getOrStart(`session-catalog:${args.cwd}`, { workingDirectory: args.cwd }),
    APP_SERVER_START_TIMEOUT_MS,
    "codex app-server start",
  );
  const params: ThreadListParams = {
    limit: Math.min(APP_SERVER_PAGE_CAP, Math.max(args.limit * 5, 50)),
    sortKey: "updated_at",
    sortDirection: "desc",
    useStateDbOnly: true,
  };
  if (args.searchTerm?.trim()) {
    params.searchTerm = args.searchTerm.trim();
  }
  if (args.cursor?.trim()) {
    params.cursor = args.cursor.trim();
  }

  const response = await client.request<ThreadListParams, ThreadListResponse>("thread/list", params, {
    timeoutMs: APP_SERVER_TIMEOUT_MS,
  });
  const threads = Array.isArray(response?.data) ? response.data : [];
  return {
    items: threads.filter((thread) => !thread.ephemeral).map(threadToRef),
    nextCursor: typeof response?.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined,
  };
}

interface RolloutHead {
  sessionId?: string;
  cwd?: string;
  createdAt?: number;
  firstUserText?: string;
  userTurns: number;
  /** False when the file exceeded the head budget, making `userTurns` a lower bound. */
  complete: boolean;
}

async function readRolloutHead(filePath: string): Promise<RolloutHead | null> {
  let raw: string;
  let complete: boolean;
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(ROLLOUT_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, ROLLOUT_HEAD_BYTES, 0);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
      // A short read means EOF was reached, so the turn count below is exact.
      complete = bytesRead < ROLLOUT_HEAD_BYTES;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const head: RolloutHead = { userTurns: 0, complete };
  // The final line of a truncated read may be incomplete; it is simply skipped.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parsed as { type?: string; payload?: Record<string, unknown> };
    const payload = record.payload ?? {};
    if (record.type === "session_meta") {
      const sessionId = payload.session_id ?? payload.id;
      if (typeof sessionId === "string") {
        head.sessionId = sessionId;
      }
      if (typeof payload.cwd === "string") {
        head.cwd = payload.cwd;
      }
      if (typeof payload.timestamp === "string") {
        const parsedTs = Date.parse(payload.timestamp);
        head.createdAt = Number.isFinite(parsedTs) ? parsedTs : undefined;
      }
      continue;
    }
    if (record.type !== "response_item" || payload.role !== "user") {
      continue;
    }
    head.userTurns += 1;
    if (!head.firstUserText) {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content
        .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
        .join("");
      head.firstUserText = extractUserFacingPrompt(text) || undefined;
    }
  }
  return head.sessionId ? head : null;
}

/**
 * Fallback for when the app-server daemon cannot be started. Reads only the
 * head of each rollout and never more than {@link ROLLOUT_SCAN_LIMIT} files.
 */
export async function listCodexSessionsViaRolloutFiles(args: {
  limit: number;
}): Promise<AgentSessionRef[]> {
  const files = await listRecentFiles(
    codexSessionsRoot(),
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    ROLLOUT_SCAN_LIMIT,
  );
  const refs: AgentSessionRef[] = [];
  for (const file of files) {
    if (refs.length >= args.limit) {
      break;
    }
    const head = await readRolloutHead(file.filePath);
    if (!head?.sessionId) {
      continue;
    }
    refs.push({
      agentId: "codex",
      sessionId: head.sessionId,
      cwd: head.cwd,
      title: head.firstUserText ? truncatePreview(head.firstUserText, 60) : path.basename(file.filePath),
      preview: head.firstUserText ? truncatePreview(head.firstUserText) : undefined,
      userTurns: head.complete ? head.userTurns : undefined,
      // A truncated scan means the file is large, which is itself evidence of a
      // substantive session, so it is never classified as one-shot.
      singleTurn: head.complete && head.userTurns < 2,
      createdAt: head.createdAt,
      updatedAt: file.mtimeMs,
      source: "rollout_file",
    });
  }
  return refs;
}

export async function listCodexSessions(args: {
  cwd: string;
  limit: number;
  searchTerm?: string;
  cursor?: string;
}): Promise<{ items: AgentSessionRef[]; nextCursor?: string; degraded?: string }> {
  try {
    return await listCodexSessionsViaAppServer(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`thread/list unavailable, falling back to rollout files: ${message}`);
    try {
      // The rollout scan has no cursor of its own; the catalog still pages over
      // what it returns, so a fallback list is shorter but not unpaged.
      const items = await listCodexSessionsViaRolloutFiles({ limit: args.limit });
      return { items, degraded: "codex_app_server" };
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger.warn(`rollout scan failed: ${fallbackMessage}`);
      return { items: [], degraded: "codex_all" };
    }
  }
}
