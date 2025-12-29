import { createLogger } from "../utils/logger.js";
import type { VectorQueryHit, VectorQueryResponse, VectorUpsertItem } from "./types.js";

const logger = createLogger("VectorSearchClient");

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/g, "");
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function pickRerankText(hit: VectorQueryHit): string {
  const md = hit.metadata ?? {};
  const candidate =
    safeString(hit.text) ||
    safeString(hit.snippet) ||
    safeString((md as any).text) ||
    safeString((md as any).snippet) ||
    safeString((md as any).text_preview);
  return candidate.trim();
}

async function fetchJson(
  url: string,
  options: RequestInit & { timeoutMs: number },
): Promise<{ ok: boolean; status: number; json?: unknown; text?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const contentType = res.headers.get("content-type") ?? "";
    const status = res.status;
    if (contentType.includes("application/json")) {
      const json = await res.json().catch(() => undefined);
      return { ok: res.ok, status, json };
    }
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkVectorServiceHealth(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; message?: string }> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/health`;
  const res = await fetchJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    return { ok: false, message: `health check failed (${res.status})` };
  }
  return { ok: true };
}

export async function upsertVectors(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  workspaceNamespace: string;
  items: VectorUpsertItem[];
}): Promise<{ ok: boolean; message?: string }> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/upsert`;
  const res = await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace_namespace: params.workspaceNamespace,
      items: params.items,
    }),
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    logger.warn(`[VectorSearchClient] upsert failed (${res.status})`);
    return { ok: false, message: `upsert failed (${res.status})` };
  }
  return { ok: true };
}

export async function queryVectors(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  workspaceNamespace: string;
  query: string;
  topK: number;
}): Promise<{ ok: boolean; message?: string; hits?: VectorQueryResponse["hits"] }> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/query`;
  const res = await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace_namespace: params.workspaceNamespace,
      query: params.query,
      topK: params.topK,
    }),
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    return { ok: false, message: `query failed (${res.status})` };
  }
  const json = res.json as unknown;
  if (!json || typeof json !== "object") {
    return { ok: false, message: "query response is not json" };
  }
  const hits = (json as any).hits;
  if (!Array.isArray(hits)) {
    return { ok: false, message: "query response missing hits" };
  }
  return { ok: true, hits };
}

type RerankItem = { id: string; score?: number };

function parseRerankItems(json: unknown, candidateIds: string[]): RerankItem[] | null {
  const fromArray = (arr: unknown[]): RerankItem[] => {
    const out: RerankItem[] = [];
    for (const entry of arr) {
      if (typeof entry === "string" && entry.trim()) {
        out.push({ id: entry.trim() });
        continue;
      }
      if (typeof entry === "number" && Number.isInteger(entry)) {
        const id = candidateIds[entry];
        if (id) out.push({ id });
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const idRaw = record.id ?? record.document_id ?? record.documentId;
      const indexRaw = record.index ?? record.document_index ?? record.documentIndex;
      const id =
        typeof idRaw === "string"
          ? idRaw.trim()
          : typeof indexRaw === "number" && Number.isInteger(indexRaw)
            ? candidateIds[indexRaw] ?? ""
            : "";
      if (!id) {
        continue;
      }
      const score =
        toNumber(record.rerank_score) ??
        toNumber(record.rerankScore) ??
        toNumber(record.relevance_score) ??
        toNumber(record.relevanceScore) ??
        toNumber(record.score);
      out.push(score === undefined ? { id } : { id, score });
    }
    return out;
  };

  if (Array.isArray(json)) {
    return fromArray(json);
  }

  if (!json || typeof json !== "object") {
    return null;
  }

  const record = json as Record<string, unknown>;
  const candidates =
    (Array.isArray(record.hits) && record.hits) ||
    (Array.isArray(record.results) && record.results) ||
    (Array.isArray(record.reranked) && record.reranked) ||
    (Array.isArray(record.data) && record.data) ||
    null;
  if (candidates) {
    return fromArray(candidates);
  }

  const order = record.order ?? record.ranked_ids ?? record.rankedIds ?? record.ids;
  if (Array.isArray(order)) {
    return fromArray(order);
  }

  return null;
}

export async function rerankVectors(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  workspaceNamespace: string;
  query: string;
  hits: VectorQueryHit[];
  topK: number;
}): Promise<{ ok: boolean; message?: string; ranked?: RerankItem[] }> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/rerank`;
  const candidates = params.hits
    .map((hit) => ({ id: hit.id, text: pickRerankText(hit), metadata: hit.metadata }))
    .filter((entry) => entry.id);

  const ids = candidates.map((entry) => entry.id);
  const documents = candidates.map((entry) => entry.text);

  const res = await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace_namespace: params.workspaceNamespace,
      query: params.query,
      topK: params.topK,
      candidates,
      ids,
      documents,
    }),
    timeoutMs: params.timeoutMs,
  });

  if (!res.ok) {
    if (res.status === 404) {
      return { ok: false, message: "rerank endpoint not found" };
    }
    logger.warn(`[VectorSearchClient] rerank failed (${res.status})`);
    return { ok: false, message: `rerank failed (${res.status})` };
  }

  const ranked = parseRerankItems(res.json, ids);
  if (!ranked || ranked.length === 0) {
    return { ok: false, message: "rerank response missing ranked results" };
  }

  return { ok: true, ranked };
}
