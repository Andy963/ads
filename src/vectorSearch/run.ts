import { createLogger } from "../utils/logger.js";
import { checkVectorServiceHealth, queryVectors, rerankVectors, upsertVectors } from "./client.js";
import { loadVectorSearchConfig } from "./config.js";
import { formatVectorSearchOutput } from "./format.js";
import { applyRerankOrder, isStaleFileHit, splitBatches, takeLastWins, toHit } from "./runHelpers.js";
import { prepareVectorUpserts } from "./indexer.js";
import { setVectorState } from "./state.js";
import type { VectorQueryHit, VectorUpsertItem } from "./types.js";
import { sha256Hex } from "./hash.js";

const logger = createLogger("VectorSearch");

let lastDisabledLogAt = 0;
let lastUnavailableLogAt = 0;

export type VectorSearchEntryNamespace = "cli" | "web" | "telegram" | "agent";

export type VectorSearchFailureCode =
  | "empty_query"
  | "invalid_request"
  | "disabled"
  | "service_unavailable"
  | "query_failed";

export interface VectorSearchHitsResult {
  ok: boolean;
  code?: VectorSearchFailureCode;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
  retryCount?: number;
  timeoutMs?: number;
  indexName?: string;
  hits: VectorQueryHit[];
  warnings: string[];
  topK: number;
}

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isRetryableHttpStatus(status: number | undefined): boolean {
  if (!status) return false;
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function shouldRetryVectorRequest(params: {
  httpStatus?: number;
  errorKind?: string;
  providerCode?: string;
}): boolean {
  const kind = String(params.errorKind ?? "").trim();
  if (kind === "timeout" || kind === "network") return true;
  if (isRetryableHttpStatus(params.httpStatus)) return true;
  // Some providers encode transient errors in a code field even when status is 200.
  const provider = String(params.providerCode ?? "").trim().toLowerCase();
  if (provider.includes("rate") || provider.includes("overload") || provider.includes("timeout")) return true;
  return false;
}

function formatVectorFailureSummary(params: {
  code: VectorSearchFailureCode;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
}): string {
  const parts: string[] = [];
  parts.push(String(params.code));
  if (params.httpStatus) parts.push(`http=${params.httpStatus}`);
  if (params.providerCode) parts.push(`provider=${params.providerCode}`);
  const msg = String(params.message ?? "").trim();
  if (msg) parts.push(`reason=${msg.length > 160 ? msg.slice(0, 159) + "…" : msg}`);
  return parts.join(" ");
}

export async function queryVectorSearchHits(params: {
  workspaceRoot: string;
  query: string;
  topK?: number;
}): Promise<VectorSearchHitsResult> {
  const startedAt = Date.now();
  const query = String(params.query ?? "").trim();
  const desiredTopK = Math.max(1, Number.isFinite(params.topK) ? Math.floor(params.topK!) : 8);
  const warnings: string[] = [];

  if (!query) {
    return { ok: false, code: "empty_query", message: "empty query", hits: [], warnings, topK: desiredTopK };
  }

  const queryHash = sha256Hex(query).slice(0, 12);

  const { config, error } = loadVectorSearchConfig();
  if (!config) {
    const now = Date.now();
    if (now - lastDisabledLogAt > 60_000) {
      lastDisabledLogAt = now;
      logger.info(`[VectorSearch] disabled: ${error ?? "unknown"}`);
    }
    return {
      ok: false,
      code: "disabled",
      message: error ?? "vector search disabled",
      retryCount: 0,
      hits: [],
      warnings,
      topK: desiredTopK,
    };
  }

  const maxTopK = Math.max(1, Math.floor(config.maxTopK));
  const maxQueryChars = Math.max(1, Math.floor(config.maxQueryChars));

  const topKRaw = Math.max(1, Number.isFinite(params.topK) ? Math.floor(params.topK!) : config.topK);
  const topK = Math.min(maxTopK, topKRaw);
  if (query.length > maxQueryChars) {
    logger.info(
      `[VectorSearch] invalid_request query_too_large qhash=${queryHash} qlen=${query.length} max_query_chars=${maxQueryChars}`,
    );
    return {
      ok: false,
      code: "invalid_request",
      message: `query too large (max ${maxQueryChars} chars)`,
      retryCount: 0,
      timeoutMs: config.timeoutMs,
      hits: [],
      warnings,
      topK,
    };
  }
  const timeoutMs = config.timeoutMs;

  try {
    logger.info(`[VectorSearch] query_start topK=${topK} qhash=${queryHash} qlen=${query.length}`);
    let retryCount = 0;
    let health = await checkVectorServiceHealth({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs,
    });
    if (!health.ok && shouldRetryVectorRequest(health) && retryCount < 1) {
      retryCount += 1;
      await sleep(250);
      health = await checkVectorServiceHealth({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs,
      });
    }
    if (!health.ok) {
      const now = Date.now();
      if (now - lastUnavailableLogAt > 60_000) {
        lastUnavailableLogAt = now;
        logger.info(`[VectorSearch] service_unavailable: ${health.message ?? "health check failed"}`);
      }
      logger.info(
        `[VectorSearch] query_end ${JSON.stringify({
          ok: 0,
          error_kind: "service_unavailable",
          http_status: health.httpStatus ?? null,
          provider_code: health.providerCode ?? null,
          timeout_ms: timeoutMs,
          retry_count: retryCount,
          ms: Date.now() - startedAt,
          qhash: queryHash,
        })}`,
      );
      return {
        ok: false,
        code: "service_unavailable",
        // Keep message as the raw provider/user-facing message. Structured fields carry
        // code/http/provider and the UI summary layer is responsible for formatting.
        message: health.message ?? "health check failed",
        httpStatus: health.httpStatus,
        providerCode: health.providerCode,
        retryCount,
        timeoutMs,
        hits: [],
        warnings,
        topK,
      };
    }

    const prepared = prepareVectorUpserts({
      workspaceRoot: params.workspaceRoot,
      namespaces: config.namespaces,
      historyScanLimit: config.historyScanLimit,
      chunkMaxChars: config.chunkMaxChars,
      chunkOverlapChars: config.chunkOverlapChars,
    });
    warnings.push(...prepared.warnings);

    const itemsToUpsert = prepared.items;
    const stateUpdates = takeLastWins(prepared.stateUpdates);
    const indexName = prepared.workspaceNamespace;

    let upsertOk = true;
    if (itemsToUpsert.length > 0) {
      logger.info(
        `[VectorSearch] upsert_start ws=${prepared.workspaceNamespace} items=${itemsToUpsert.length} batches=${Math.ceil(
          itemsToUpsert.length / Math.max(1, config.upsertBatchSize),
        )}`,
      );
      const batches = splitBatches<VectorUpsertItem>(itemsToUpsert, config.upsertBatchSize);
      for (const batch of batches) {
        const result = await upsertVectors({
          baseUrl: config.baseUrl,
          token: config.token,
          timeoutMs,
          workspaceNamespace: prepared.workspaceNamespace,
          items: batch,
        });
        if (!result.ok) {
          upsertOk = false;
          warnings.push(
            formatVectorFailureSummary({
              code: "query_failed",
              message: result.message ?? "index update failed",
              httpStatus: result.httpStatus,
              providerCode: result.providerCode,
            }),
          );
          break;
        }
      }
      logger.info(`[VectorSearch] upsert_done ok=${upsertOk ? 1 : 0}`);
    }

    if (upsertOk) {
      for (const update of stateUpdates) {
        setVectorState(params.workspaceRoot, update.key, update.value);
      }
    }

    const queryTopK = Math.min(maxTopK, Math.min(60, Math.max(topK * 3, topK)));
    let queryResult = await queryVectors({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs,
      workspaceNamespace: prepared.workspaceNamespace,
      query,
      topK: queryTopK,
    });
    if (!queryResult.ok && shouldRetryVectorRequest(queryResult) && retryCount < 2) {
      retryCount += 1;
      await sleep(250);
      queryResult = await queryVectors({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs,
        workspaceNamespace: prepared.workspaceNamespace,
        query,
        topK: queryTopK,
      });
    }
    if (!queryResult.ok || !queryResult.hits) {
      logger.warn(`[VectorSearch] query failed: ${queryResult.message ?? "unknown"}`);
      logger.info(
        `[VectorSearch] query_end ${JSON.stringify({
          ok: 0,
          error_kind: "query_failed",
          http_status: queryResult.httpStatus ?? null,
          provider_code: queryResult.providerCode ?? null,
          topK,
          query_topk: queryTopK,
          timeout_ms: timeoutMs,
          retry_count: retryCount,
          index_name: indexName,
          ms: Date.now() - startedAt,
          qhash: queryHash,
        })}`,
      );
      return {
        ok: false,
        code: "query_failed",
        // Keep message as the raw provider/user-facing message. Structured fields carry
        // code/http/provider and the UI summary layer is responsible for formatting.
        message: queryResult.message ?? "unknown",
        httpStatus: queryResult.httpStatus,
        providerCode: queryResult.providerCode,
        retryCount,
        timeoutMs,
        indexName,
        hits: [],
        warnings,
        topK,
      };
    }

    const rawHits = queryResult.hits;
    const hits: VectorQueryHit[] = [];
    for (const raw of rawHits) {
      const hit = toHit(raw);
      if (!hit) continue;
      if (isStaleFileHit(hit, prepared.fileHashes)) {
        continue;
      }
      hits.push(hit);
    }

    logger.info(
      `[VectorSearch] query_hits ws=${prepared.workspaceNamespace} raw=${rawHits.length} kept=${hits.length} warnings=${warnings.length} ms=${Date.now() - startedAt} qhash=${queryHash}`,
    );

    let finalHits = hits;
    if (hits.length >= 2) {
      const rerank = await rerankVectors({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs,
        workspaceNamespace: prepared.workspaceNamespace,
        query,
        hits,
        topK,
      });
      if (rerank.ok && rerank.ranked && rerank.ranked.length > 0) {
        finalHits = applyRerankOrder(hits, rerank.ranked);
        logger.info(`[VectorSearch] rerank_ok qhash=${queryHash}`);
      } else if (rerank.message && rerank.message !== "rerank endpoint not found") {
        warnings.push(rerank.message);
        logger.info(`[VectorSearch] rerank_skip reason=${rerank.message} qhash=${queryHash}`);
      }
    }

    logger.info(
      `[VectorSearch] query_end ${JSON.stringify({
        ok: 1,
        hits: finalHits.length,
        topK,
        query_topk: queryTopK,
        timeout_ms: timeoutMs,
        retry_count: retryCount,
        index_name: indexName,
        ms: Date.now() - startedAt,
        qhash: queryHash,
      })}`,
    );
    return {
      ok: true,
      hits: finalHits.slice(0, topK),
      warnings,
      topK,
      retryCount,
      timeoutMs,
      indexName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[VectorSearch] Failed to query vectors: ${message}`, error);
    logger.info(
      `[VectorSearch] query_end ${JSON.stringify({
        ok: 0,
        error_kind: "query_failed",
        timeout_ms: timeoutMs,
        retry_count: 0,
        ms: Date.now() - startedAt,
        qhash: sha256Hex(query).slice(0, 12),
      })}`,
    );
    return { ok: false, code: "query_failed", message, hits: [], warnings, topK, retryCount: 0, timeoutMs };
  }
}

export async function runVectorSearch(params: {
  workspaceRoot: string;
  query: string;
  entryNamespace: VectorSearchEntryNamespace;
}): Promise<string> {
  void params.entryNamespace;

  const query = String(params.query ?? "").trim();
  const result = await queryVectorSearchHits({ workspaceRoot: params.workspaceRoot, query });

  if (!result.ok) {
    if (result.code === "empty_query") {
      return "用法: /vsearch <query>";
    }
    if (result.code === "disabled") {
      return [
        `❌ /vsearch 未启用: ${result.message ?? "unknown"}`,
        "💡 你可以先用 /search 进行关键词检索。",
      ].join("\n");
    }
    if (result.code === "service_unavailable") {
      return [
        `❌ 向量服务不可用: ${result.message ?? "health check failed"}`,
        "💡 你可以先用 /search 进行关键词检索。",
      ].join("\n");
    }
    return [
      `❌ 向量查询失败: ${result.message ?? "unknown"}`,
      "💡 你可以先用 /search 进行关键词检索。",
    ].join("\n");
  }

  return formatVectorSearchOutput({ query, hits: result.hits, topK: result.topK, warnings: result.warnings });
}

export async function syncVectorSearch(params: {
  workspaceRoot: string;
}): Promise<{ ok: boolean; message: string; count: number }> {
  const { config, error } = loadVectorSearchConfig();
  if (!config) {
    return { ok: false, message: `向量服务未启用: ${error ?? "unknown"}`, count: 0 };
  }

  const health = await checkVectorServiceHealth({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.timeoutMs,
  });
  if (!health.ok) {
    return { ok: false, message: `向量服务不可用: ${health.message ?? "health check failed"}`, count: 0 };
  }

  const prepared = prepareVectorUpserts({
    workspaceRoot: params.workspaceRoot,
    namespaces: config.namespaces,
    historyScanLimit: config.historyScanLimit,
    chunkMaxChars: config.chunkMaxChars,
    chunkOverlapChars: config.chunkOverlapChars,
  });

  const itemsToUpsert = prepared.items;
  const stateUpdates = takeLastWins(prepared.stateUpdates);

  if (itemsToUpsert.length === 0) {
    // Even when there's nothing new to upsert, we may still want to advance incremental state
    // (e.g. blank files/history rows that produce no chunks).
    for (const update of stateUpdates) {
      setVectorState(params.workspaceRoot, update.key, update.value);
    }
    return { ok: true, message: "已经是最新状态，无需同步。", count: 0 };
  }

  const batches = splitBatches<VectorUpsertItem>(itemsToUpsert, config.upsertBatchSize);
  for (const batch of batches) {
    const result = await upsertVectors({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
      workspaceNamespace: prepared.workspaceNamespace,
      items: batch,
    });
    if (!result.ok) {
      return { ok: false, message: `同步失败: ${result.message ?? "unknown"}`, count: 0 };
    }
  }

  for (const update of stateUpdates) {
    setVectorState(params.workspaceRoot, update.key, update.value);
  }

  return { ok: true, message: `成功同步 ${itemsToUpsert.length} 个片段。`, count: itemsToUpsert.length };
}
