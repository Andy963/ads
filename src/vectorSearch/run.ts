import { createLogger } from "../utils/logger.js";
import { checkVectorServiceHealth, queryVectors, rerankVectors, upsertVectors } from "./client.js";
import { loadVectorSearchConfig } from "./config.js";
import { formatVectorSearchOutput } from "./format.js";
import { prepareVectorUpserts } from "./indexer.js";
import { setVectorState } from "./state.js";
import type { VectorQueryHit, VectorUpsertItem } from "./types.js";
import { sha256Hex } from "./hash.js";

const logger = createLogger("VectorSearch");

let lastDisabledLogAt = 0;
let lastUnavailableLogAt = 0;

function takeLastWins(entries: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.key || !entry.value) continue;
    map.set(entry.key, entry.value);
  }
  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

function toHit(raw: unknown): VectorQueryHit | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const hit: VectorQueryHit = { id };
  const scoreRaw = record.score;
  if (typeof scoreRaw === "number") hit.score = scoreRaw;
  if (typeof scoreRaw === "string") {
    const parsed = Number.parseFloat(scoreRaw);
    if (Number.isFinite(parsed)) hit.score = parsed;
  }
  const metadataRaw = record.metadata;
  if (metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)) {
    hit.metadata = metadataRaw as Record<string, unknown>;
  }
  if (typeof record.snippet === "string") hit.snippet = record.snippet;
  if (typeof record.text_preview === "string" && !hit.snippet) hit.snippet = record.text_preview;
  if (typeof record.text === "string") hit.text = record.text;
  return hit;
}

function isStaleFileHit(hit: VectorQueryHit, fileHashes: Map<string, string>): boolean {
  const md = hit.metadata ?? {};
  const sourceType = md["source_type"];
  if (sourceType !== "spec" && sourceType !== "adr") return false;
  const path = typeof md["path"] === "string" ? md["path"] : "";
  const contentHash = typeof md["content_hash"] === "string" ? md["content_hash"] : "";
  if (!path || !contentHash) return false;
  const current = fileHashes.get(path);
  if (!current) return false;
  return current !== contentHash;
}

function splitBatches<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function applyRerankOrder(hits: VectorQueryHit[], ranked: Array<{ id: string; score?: number }>): VectorQueryHit[] {
  const remaining = new Map<string, VectorQueryHit>();
  hits.forEach((hit) => remaining.set(hit.id, hit));

  const ordered: VectorQueryHit[] = [];
  for (const entry of ranked) {
    const hit = remaining.get(entry.id);
    if (!hit) {
      continue;
    }
    remaining.delete(entry.id);
    if (entry.score !== undefined) {
      hit.rerankScore = entry.score;
    }
    ordered.push(hit);
  }

  for (const hit of hits) {
    if (!remaining.has(hit.id)) {
      continue;
    }
    ordered.push(hit);
    remaining.delete(hit.id);
  }

  return ordered;
}

export type VectorSearchEntryNamespace = "cli" | "web" | "telegram" | "agent";

export type VectorSearchFailureCode =
  | "empty_query"
  | "disabled"
  | "service_unavailable"
  | "query_failed";

export interface VectorSearchHitsResult {
  ok: boolean;
  code?: VectorSearchFailureCode;
  message?: string;
  hits: VectorQueryHit[];
  warnings: string[];
  topK: number;
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
      hits: [],
      warnings,
      topK: desiredTopK,
    };
  }

  const topK = Math.max(1, Number.isFinite(params.topK) ? Math.floor(params.topK!) : config.topK);
  const queryHash = sha256Hex(query).slice(0, 12);

  try {
    logger.info(`[VectorSearch] query_start topK=${topK} qhash=${queryHash} qlen=${query.length}`);
    const health = await checkVectorServiceHealth({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
    });
    if (!health.ok) {
      const now = Date.now();
      if (now - lastUnavailableLogAt > 60_000) {
        lastUnavailableLogAt = now;
        logger.info(`[VectorSearch] service_unavailable: ${health.message ?? "health check failed"}`);
      }
      return {
        ok: false,
        code: "service_unavailable",
        message: health.message ?? "health check failed",
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
          timeoutMs: config.timeoutMs,
          workspaceNamespace: prepared.workspaceNamespace,
          items: batch,
        });
        if (!result.ok) {
          upsertOk = false;
          warnings.push(result.message ?? "index update failed");
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

    const queryTopK = Math.min(60, Math.max(topK * 3, topK));
    const queryResult = await queryVectors({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
      workspaceNamespace: prepared.workspaceNamespace,
      query,
      topK: queryTopK,
    });
    if (!queryResult.ok || !queryResult.hits) {
      logger.warn(`[VectorSearch] query failed: ${queryResult.message ?? "unknown"}`);
      logger.info(`[VectorSearch] query_end ok=0 ms=${Date.now() - startedAt} qhash=${queryHash}`);
      return {
        ok: false,
        code: "query_failed",
        message: queryResult.message ?? "unknown",
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
        timeoutMs: config.timeoutMs,
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
      `[VectorSearch] query_end ok=1 hits=${finalHits.length} topK=${topK} ms=${Date.now() - startedAt} qhash=${queryHash}`,
    );
    return { ok: true, hits: finalHits.slice(0, topK), warnings, topK };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[VectorSearch] Failed to query vectors: ${message}`, error);
    logger.info(`[VectorSearch] query_end ok=0 ms=${Date.now() - startedAt} qhash=${sha256Hex(query).slice(0, 12)}`);
    return { ok: false, code: "query_failed", message, hits: [], warnings, topK };
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
