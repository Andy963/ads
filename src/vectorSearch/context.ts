import { createLogger } from "../utils/logger.js";
import { getStateDatabase } from "../state/database.js";
import { queryVectorSearchHits } from "./run.js";
import { loadVectorSearchConfig } from "./config.js";
import { resolveWorkspaceStateDbPath } from "./state.js";
import { sha256Hex } from "./hash.js";
import { resolveVectorAutoContextConfig, type VectorAutoContextConfig } from "./autoContextConfig.js";
import { formatVectorAutoContext, isChatUserEcho } from "./autoContextFormat.js";
import { normalizeWhitespace, safeString, toNumber } from "./autoContextUtils.js";

const logger = createLogger("VectorSearchContext");

export { resolveVectorAutoContextConfig } from "./autoContextConfig.js";
export type { VectorAutoContextConfig } from "./autoContextConfig.js";
export { formatVectorAutoContext } from "./autoContextFormat.js";

export interface VectorAutoContextReport {
  workspaceRoot: string;
  queryHash: string;
  queryLen: number;
  cacheHit: boolean;
  attempted: boolean;
  ok: boolean;
  code?: string;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
  retryCount?: number;
  timeoutMs?: number;
  indexName?: string;
  hits: number;
  filtered: number;
  injected: boolean;
  injectedChars: number;
  elapsedMs: number;
  warningsCount: number;
}

function normalizeForTriggerMatch(text: string): string {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isBareTriggerQuery(query: string, triggers: string[]): boolean {
  const normalized = normalizeForTriggerMatch(query);
  if (!normalized) return false;
  const triggerNorms = triggers.map(normalizeForTriggerMatch).filter(Boolean);
  if (triggerNorms.includes(normalized)) {
    return true;
  }
  for (const trigger of triggerNorms) {
    if (!trigger) continue;
    if (!normalized.includes(trigger)) continue;
    // Allow small filler characters around the trigger (e.g. "继续一下", "再继续").
    if (normalized.length <= trigger.length + 4) {
      return true;
    }
  }
  return false;
}

function looksLikePathOrSymbol(text: string): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  // File paths / extensions / stack traces / URLs.
  if (/\b[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(raw)) return true;
  if (/\b[a-zA-Z0-9_.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cpp|c|h|sql|md|yaml|yml|toml|json)\b/i.test(raw)) return true;
  if (/https?:\/\/\S+/i.test(raw)) return true;
  // Common code symbols.
  if (/\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/.test(raw)) return true;
  if (/\b[A-Za-z_][A-Za-z0-9_]{2,}\s*\(/.test(raw)) return true;
  // Error-ish tokens.
  if (/\b(Error|Exception|Traceback|panic|stack|failed|ENOENT)\b/i.test(raw)) return true;
  return false;
}

function containsAnyKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeForTriggerMatch(text);
  if (!normalized) return false;
  for (const k of keywords) {
    const kw = normalizeForTriggerMatch(k);
    if (!kw) continue;
    if (normalized.includes(kw)) return true;
  }
  return false;
}

function shouldAttemptVectorAutoContext(params: {
  originalQuery: string;
  mode: VectorAutoContextConfig["mode"];
  allowBareTriggers: boolean;
  minQueryChars: number;
  triggerKeywords: string[];
  intentKeywords: string[];
}): { should: boolean; reason?: string } {
  const query = String(params.originalQuery ?? "").trim();
  if (!query) return { should: false, reason: "empty_query" };
  if (query.startsWith("/")) return { should: false, reason: "slash_command" };

  const isBareTrigger = isBareTriggerQuery(query, params.triggerKeywords);
  const hasIntent = looksLikePathOrSymbol(query) || containsAnyKeyword(query, params.intentKeywords);

  if (params.mode === "always") {
    return { should: true };
  }

  if (isBareTrigger) {
    if (!params.allowBareTriggers) {
      return { should: false, reason: "bare_trigger_disabled" };
    }
    return { should: true };
  }

  if (!hasIntent) {
    return { should: false, reason: "no_intent" };
  }

  const minChars = Math.max(1, Math.floor(params.minQueryChars));
  if (query.length < minChars) {
    return { should: false, reason: `query_too_short(min=${minChars})` };
  }

  return { should: true };
}

function clampQuery(text: string, maxChars = 600): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

type HistoryRow = { id: number; role: string; text: string; kind: string | null };

function loadRecentHistoryRows(params: {
  workspaceRoot: string;
  historyNamespace?: string;
  historySessionId?: string;
  limit: number;
}): HistoryRow[] {
  const dbPath = resolveWorkspaceStateDbPath(params.workspaceRoot);
  if (!dbPath) {
    return [];
  }

  const db = getStateDatabase(dbPath);
  const limit = Math.max(1, Math.floor(params.limit));
  const ns = typeof params.historyNamespace === "string" ? params.historyNamespace.trim() : "";
  const sessionId = typeof params.historySessionId === "string" ? params.historySessionId.trim() : "";

  try {
    if (ns && sessionId) {
      return db
        .prepare(
          `SELECT id, role, text, kind
           FROM history_entries
           WHERE namespace = ?
             AND session_id = ?
             AND role IN ('user','ai')
             AND (kind IS NULL OR kind NOT IN ('command','error'))
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(ns, sessionId, limit) as HistoryRow[];
    }

    return db
      .prepare(
        `SELECT id, role, text, kind
         FROM history_entries
         WHERE role IN ('user','ai')
           AND (kind IS NULL OR kind NOT IN ('command','error'))
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as HistoryRow[];
  } catch (error) {
    logger.warn("[VectorSearchContext] Failed to read recent history rows", error);
    return [];
  }
}

function deriveQueryFromHistory(params: {
  workspaceRoot: string;
  historyNamespace?: string;
  historySessionId?: string;
  originalQuery: string;
  triggers: string[];
}): string {
  const rows = loadRecentHistoryRows({
    workspaceRoot: params.workspaceRoot,
    historyNamespace: params.historyNamespace,
    historySessionId: params.historySessionId,
    limit: 40,
  });
  if (rows.length === 0) {
    return params.originalQuery;
  }

  const originalNorm = normalizeForTriggerMatch(params.originalQuery);
  const triggers = params.triggers ?? [];

  const isGood = (candidate: string, role: string): boolean => {
    const trimmed = String(candidate ?? "").trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/")) return false;
    const norm = normalizeForTriggerMatch(trimmed);
    if (!norm) return false;
    if (originalNorm && norm === originalNorm) return false;
    if (isBareTriggerQuery(trimmed, triggers)) return false;
    if (role === "ai" && trimmed.length < 16) return false;
    return true;
  };

  for (const row of rows) {
    if (row.role !== "user") continue;
    if (isGood(row.text, "user")) {
      return clampQuery(row.text);
    }
  }

  for (const row of rows) {
    if (row.role !== "ai") continue;
    if (isGood(row.text, "ai")) {
      return clampQuery(row.text);
    }
  }

  return params.originalQuery;
}

type AutoContextCacheEntry = {
  updatedAtMs: number;
  context: string | null;
  queryHash: string;
};

const AUTO_CONTEXT_CACHE = new Map<string, AutoContextCacheEntry>();

export async function maybeBuildVectorAutoContext(params: {
  workspaceRoot: string;
  query: string;
  historyNamespace?: string;
  historySessionId?: string;
  onReport?: (report: VectorAutoContextReport) => void;
}): Promise<string | null> {
  const config = resolveVectorAutoContextConfig();
  if (!config.enabled) {
    return null;
  }

  const originalQuery = String(params.query ?? "").trim();
  if (!originalQuery) {
    return null;
  }
  if (originalQuery.startsWith("/")) {
    return null;
  }

  // Cheap gate before any I/O.
  const gate = shouldAttemptVectorAutoContext({
    originalQuery,
    mode: config.mode,
    allowBareTriggers: config.allowBareTriggers,
    minQueryChars: config.minQueryChars,
    triggerKeywords: config.triggerKeywords,
    intentKeywords: config.intentKeywords,
  });
  if (!gate.should) {
    const queryHash = sha256Hex(originalQuery).slice(0, 12);
    const queryLen = originalQuery.length;
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: false,
      attempted: false,
      ok: true,
      code: "skipped",
      message: gate.reason ?? "gated",
      retryCount: 0,
      hits: 0,
      filtered: 0,
      injected: false,
      injectedChars: 0,
      elapsedMs: 0,
      warningsCount: 0,
    });
    return null;
  }

  // If vector search is not configured, skip without attempting a network call.
  const { config: vectorConfig } = loadVectorSearchConfig();
  if (!vectorConfig) {
    const queryHash = sha256Hex(originalQuery).slice(0, 12);
    const queryLen = originalQuery.length;
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: false,
      attempted: false,
      ok: false,
      code: "disabled",
      message: "vector search disabled",
      retryCount: 0,
      hits: 0,
      filtered: 0,
      injected: false,
      injectedChars: 0,
      elapsedMs: 0,
      warningsCount: 0,
    });
    return null;
  }

  const query = isBareTriggerQuery(originalQuery, config.triggerKeywords)
    ? deriveQueryFromHistory({
        workspaceRoot: params.workspaceRoot,
        historyNamespace: params.historyNamespace,
        historySessionId: params.historySessionId,
        originalQuery,
        triggers: config.triggerKeywords,
      })
    : originalQuery;

  const queryHash = sha256Hex(query).slice(0, 12);
  const queryLen = query.length;

  const cacheKey = [
    String(params.workspaceRoot ?? "").trim(),
    safeString(params.historyNamespace),
    safeString(params.historySessionId),
  ]
    .filter(Boolean)
    .join("::");
  const now = Date.now();
  const cached = cacheKey ? AUTO_CONTEXT_CACHE.get(cacheKey) : undefined;
  if (cached && cached.queryHash === queryHash && now - cached.updatedAtMs < config.minIntervalMs) {
    const injected = Boolean(cached.context && cached.context.trim());
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: true,
      attempted: false,
      ok: true,
      retryCount: 0,
      hits: 0,
      filtered: 0,
      injected,
      injectedChars: injected ? cached.context!.length : 0,
      elapsedMs: 0,
      warningsCount: 0,
    });
    logger.info(
      `[VectorAutoContext] cache_hit injected=${injected ? 1 : 0} chars=${injected ? cached.context!.length : 0} qhash=${queryHash} qlen=${queryLen}`,
    );
    return cached.context;
  }
  if (cached && now - cached.updatedAtMs < config.minIntervalMs) {
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: true,
      attempted: false,
      ok: true,
      code: "skipped",
      message: `throttled(minIntervalMs=${config.minIntervalMs})`,
      retryCount: 0,
      hits: 0,
      filtered: 0,
      injected: false,
      injectedChars: 0,
      elapsedMs: 0,
      warningsCount: 0,
    });
    logger.info(`[VectorAutoContext] throttled qhash=${queryHash} qlen=${queryLen} minIntervalMs=${config.minIntervalMs}`);
    return null;
  }

  const startedAt = Date.now();
  const requestTopK = Math.min(24, Math.max(6, config.topK * 3));
  const result = await queryVectorSearchHits({
    workspaceRoot: params.workspaceRoot,
    query,
    topK: requestTopK,
  });
  const elapsedMs = Date.now() - startedAt;
  if (!result.ok || result.hits.length === 0) {
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context: null, queryHash });
    }
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: false,
      attempted: true,
      ok: Boolean(result.ok),
      code: result.ok ? undefined : result.code,
      message: result.message,
      httpStatus: result.httpStatus,
      providerCode: result.providerCode,
      retryCount: result.retryCount,
      timeoutMs: result.timeoutMs,
      indexName: result.indexName,
      hits: result.hits.length,
      filtered: 0,
      injected: false,
      injectedChars: 0,
      elapsedMs,
      warningsCount: result.warnings.length,
    });
    logger.info(
      `[VectorAutoContext] query_done ok=${result.ok ? 1 : 0} hits=${result.hits.length} injected=0 ms=${elapsedMs} qhash=${queryHash} qlen=${queryLen}`,
    );
    return null;
  }

  const normalizedQuery = normalizeWhitespace(query).toLowerCase();

  const filtered = result.hits
    .filter((hit) => !isChatUserEcho(hit, normalizedQuery))
    .filter((hit) => {
      const score = toNumber(hit.score);
      if (score === undefined) return true;
      return score >= config.minScore;
    })
    .slice(0, config.topK);

  if (filtered.length === 0) {
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context: null, queryHash });
    }
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: false,
      attempted: true,
      ok: true,
      retryCount: result.retryCount,
      timeoutMs: result.timeoutMs,
      indexName: result.indexName,
      hits: result.hits.length,
      filtered: 0,
      injected: false,
      injectedChars: 0,
      elapsedMs,
      warningsCount: result.warnings.length,
    });
    logger.info(
      `[VectorAutoContext] filtered_empty hits=${result.hits.length} injected=0 ms=${elapsedMs} qhash=${queryHash} qlen=${queryLen}`,
    );
    return null;
  }

  try {
    const formatted = formatVectorAutoContext({ hits: filtered, maxChars: config.maxChars });
    const context = formatted.trim() ? formatted : null;
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context, queryHash });
    }
    const injected = Boolean(context && context.trim());
    params.onReport?.({
      workspaceRoot: params.workspaceRoot,
      queryHash,
      queryLen,
      cacheHit: false,
      attempted: true,
      ok: true,
      retryCount: result.retryCount,
      timeoutMs: result.timeoutMs,
      indexName: result.indexName,
      hits: result.hits.length,
      filtered: filtered.length,
      injected,
      injectedChars: injected ? context!.length : 0,
      elapsedMs,
      warningsCount: result.warnings.length,
    });
    logger.info(
      `[VectorAutoContext] injected=${injected ? 1 : 0} hits=${result.hits.length} filtered=${filtered.length} chars=${injected ? context!.length : 0} ms=${elapsedMs} qhash=${queryHash} qlen=${queryLen}`,
    );
    return context;
  } catch (error) {
    logger.warn(`[VectorSearchContext] Failed to format context`, error);
    return null;
  }
}
