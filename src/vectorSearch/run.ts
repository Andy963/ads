import { createLogger } from "../utils/logger.js";
import { checkWorkspaceInit } from "../telegram/utils/workspaceInitChecker.js";
import { checkVectorServiceHealth, queryVectors, upsertVectors } from "./client.js";
import { loadVectorSearchConfig } from "./config.js";
import { formatVectorSearchOutput } from "./format.js";
import { prepareVectorUpserts } from "./indexer.js";
import { setVectorState } from "./state.js";
import type { VectorQueryHit, VectorUpsertItem } from "./types.js";

const logger = createLogger("VectorSearch");

function takeLastWins(entries: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.key || !entry.value) continue;
    map.set(entry.key, entry.value);
  }
  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

function toHit(raw: any): VectorQueryHit | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const hit: VectorQueryHit = { id };
  if (typeof raw.score === "number") hit.score = raw.score;
  if (typeof raw.score === "string") {
    const parsed = Number.parseFloat(raw.score);
    if (Number.isFinite(parsed)) hit.score = parsed;
  }
  if (raw.metadata && typeof raw.metadata === "object") hit.metadata = raw.metadata as Record<string, unknown>;
  if (typeof raw.snippet === "string") hit.snippet = raw.snippet;
  if (typeof raw.text_preview === "string" && !hit.snippet) hit.snippet = raw.text_preview;
  if (typeof raw.text === "string") hit.text = raw.text;
  return hit;
}

function isStaleFileHit(hit: VectorQueryHit, fileHashes: Map<string, string>): boolean {
  const md = hit.metadata ?? {};
  const sourceType = (md as any).source_type;
  if (sourceType !== "spec" && sourceType !== "adr") return false;
  const path = typeof (md as any).path === "string" ? (md as any).path : "";
  const contentHash = typeof (md as any).content_hash === "string" ? (md as any).content_hash : "";
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

export type VectorSearchEntryNamespace = "cli" | "web" | "telegram" | "agent";

export type VectorSearchFailureCode =
  | "empty_query"
  | "workspace_not_initialized"
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
  const query = String(params.query ?? "").trim();
  const desiredTopK = Math.max(1, Number.isFinite(params.topK) ? Math.floor(params.topK!) : 8);
  const warnings: string[] = [];

  if (!query) {
    return { ok: false, code: "empty_query", message: "empty query", hits: [], warnings, topK: desiredTopK };
  }

  const initStatus = checkWorkspaceInit(params.workspaceRoot);
  if (!initStatus.initialized) {
    return {
      ok: false,
      code: "workspace_not_initialized",
      message: initStatus.details ?? "workspace not initialized",
      hits: [],
      warnings,
      topK: desiredTopK,
    };
  }

  const { config, error } = loadVectorSearchConfig();
  if (!config) {
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

  try {
    const health = await checkVectorServiceHealth({
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
    });
    if (!health.ok) {
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
      if (hits.length >= topK) {
        // We already asked for a larger topK to allow filtering; stop once enough.
        break;
      }
    }

    return { ok: true, hits, warnings, topK };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[VectorSearch] Failed to query vectors: ${message}`, error);
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
    if (result.code === "workspace_not_initialized") {
      return [
        "❌ 当前工作区尚未初始化，无法使用 /vsearch",
        "💡 可用 /search 进行关键词检索，或先初始化 ADS 工作区后再试。",
      ].join("\n");
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
  const initStatus = checkWorkspaceInit(params.workspaceRoot);
  if (!initStatus.initialized) {
    return { ok: false, message: "工作区尚未初始化", count: 0 };
  }

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
