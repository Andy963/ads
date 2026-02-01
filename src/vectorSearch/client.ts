import { createLogger } from "../utils/logger.js";
import type { VectorQueryHit, VectorQueryResponse, VectorUpsertItem } from "./types.js";

const logger = createLogger("VectorSearchClient");

type FetchErrorKind = "timeout" | "network";

type FetchError = {
  kind: FetchErrorKind;
  name?: string;
  message: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function joinNonEmpty(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function summarizeErrorDetails(details: unknown): string | undefined {
  if (!details) return undefined;

  if (Array.isArray(details) && details.length > 0) {
    const first = details[0];
    if (!isRecord(first)) return undefined;
    const loc = Array.isArray(first.loc) ? first.loc.map((v) => safeString(v)).filter(Boolean).join(".") : "";
    const msg = safeString(first.msg) || safeString(first.message);
    const type = safeString(first.type);
    const location = loc ? `at ${loc}` : "";
    return joinNonEmpty([type, location, msg]);
  }

  if (isRecord(details)) {
    if (details.max_topk !== undefined) {
      const maxTopK = safeString(details.max_topk);
      return maxTopK ? `max_topk=${maxTopK}` : undefined;
    }
    if (details.max_query_chars !== undefined) {
      const maxChars = safeString(details.max_query_chars);
      return maxChars ? `max_query_chars=${maxChars}` : undefined;
    }
  }

  return undefined;
}

function pickRerankText(hit: VectorQueryHit): string {
  const md = hit.metadata ?? {};
  const candidate =
    safeString(hit.text) ||
    safeString(hit.snippet) ||
    safeString(md["text"]) ||
    safeString(md["snippet"]) ||
    safeString(md["text_preview"]);
  return candidate.trim();
}

async function fetchJson(
  url: string,
  options: RequestInit & { timeoutMs: number },
): Promise<{ ok: boolean; status: number; json?: unknown; text?: string; error?: FetchError }> {
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
  } catch (error) {
    const anyErr = error as { name?: unknown; message?: unknown };
    const name = typeof anyErr?.name === "string" ? anyErr.name : undefined;
    const message = typeof anyErr?.message === "string" ? anyErr.message : String(error);
    const kind: FetchErrorKind = name === "AbortError" ? "timeout" : "network";
    return { ok: false, status: 0, error: { kind, name, message } };
  } finally {
    clearTimeout(timer);
  }
}

function extractErrorInfo(payload: { json?: unknown; text?: string; status: number; error?: FetchError }): {
  providerCode?: string;
  message?: string;
} {
  if (payload.error) {
    const label = payload.error.kind === "timeout" ? "timeout" : "network";
    return { providerCode: label, message: payload.error.message };
  }

  const json = payload.json;
  if (isRecord(json)) {
    const root = json;
    const nested = isRecord(root.error) ? (root.error as Record<string, unknown>) : null;

    const pickCode = (record: Record<string, unknown>): string | undefined => {
      const codeRaw = record.code ?? record.error_code ?? record.errorCode ?? record.type ?? record.status;
      if (typeof codeRaw === "string" && codeRaw.trim()) return codeRaw.trim();
      if (typeof codeRaw === "number" && Number.isFinite(codeRaw)) return String(codeRaw);
      return undefined;
    };

    const pickMessage = (record: Record<string, unknown>): string | undefined => {
      const msgRaw = record.message ?? record.error ?? record.detail ?? record.reason;
      if (typeof msgRaw === "string" && msgRaw.trim()) return msgRaw.trim();
      return undefined;
    };

    const requestIdRaw = root.request_id ?? root.requestId;
    const requestId = typeof requestIdRaw === "string" && requestIdRaw.trim() ? requestIdRaw.trim() : "";

    const providerCode = pickCode(nested ?? root) ?? pickCode(root);
    const message = pickMessage(nested ?? root) ?? pickMessage(root);
    const details = summarizeErrorDetails((nested ?? root).details);

    const combined = (() => {
      const base = joinNonEmpty([message, details ? `(${details})` : undefined]);
      if (requestId) {
        return joinNonEmpty([base, `(request_id=${requestId})`]);
      }
      return base;
    })();

    return { providerCode: providerCode || undefined, message: combined || undefined };
  }

  const text = String(payload.text ?? "").trim();
  if (text) {
    return { message: text.slice(0, 280) };
  }
  return { message: payload.status ? `http ${payload.status}` : "request failed" };
}

export async function checkVectorServiceHealth(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; httpStatus?: number; providerCode?: string; message?: string; errorKind?: FetchErrorKind | "http" }> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/health`;
  const res = await fetchJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    const info = extractErrorInfo(res);
    const errorKind: FetchErrorKind | "http" = res.error ? res.error.kind : "http";
    return {
      ok: false,
      httpStatus: res.status || undefined,
      providerCode: info.providerCode,
      message: info.message ?? `health check failed (${res.status})`,
      errorKind,
    };
  }
  return { ok: true };
}

export async function upsertVectors(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  workspaceNamespace: string;
  items: VectorUpsertItem[];
}): Promise<{ ok: boolean; httpStatus?: number; providerCode?: string; message?: string; errorKind?: FetchErrorKind | "http" }> {
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
    const info = extractErrorInfo(res);
    logger.warn(`[VectorSearchClient] upsert failed (${res.status || 0})`);
    const errorKind: FetchErrorKind | "http" = res.error ? res.error.kind : "http";
    return {
      ok: false,
      httpStatus: res.status || undefined,
      providerCode: info.providerCode,
      message: info.message ?? `upsert failed (${res.status})`,
      errorKind,
    };
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
}): Promise<{
  ok: boolean;
  httpStatus?: number;
  providerCode?: string;
  message?: string;
  errorKind?: FetchErrorKind | "http" | "invalid_json";
  hits?: VectorQueryResponse["hits"];
}> {
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
    const info = extractErrorInfo(res);
    const errorKind: FetchErrorKind | "http" = res.error ? res.error.kind : "http";
    return {
      ok: false,
      httpStatus: res.status || undefined,
      providerCode: info.providerCode,
      message: info.message ?? `query failed (${res.status})`,
      errorKind,
    };
  }
  const json = res.json as unknown;
  if (!json || typeof json !== "object") {
    return { ok: false, httpStatus: res.status || undefined, message: "query response is not json", errorKind: "invalid_json" };
  }
  const hits = (json as Record<string, unknown>).hits;
  if (!Array.isArray(hits)) {
    return { ok: false, httpStatus: res.status || undefined, message: "query response missing hits", errorKind: "invalid_json" };
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
}): Promise<{
  ok: boolean;
  httpStatus?: number;
  providerCode?: string;
  message?: string;
  errorKind?: FetchErrorKind | "http" | "invalid_json";
  ranked?: RerankItem[];
}> {
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
      return { ok: false, httpStatus: 404, message: "rerank endpoint not found", errorKind: "http" };
    }
    const info = extractErrorInfo(res);
    logger.warn(`[VectorSearchClient] rerank failed (${res.status})`);
    const errorKind: FetchErrorKind | "http" = res.error ? res.error.kind : "http";
    return {
      ok: false,
      httpStatus: res.status || undefined,
      providerCode: info.providerCode,
      message: info.message ?? `rerank failed (${res.status})`,
      errorKind,
    };
  }

  const ranked = parseRerankItems(res.json, ids);
  if (!ranked || ranked.length === 0) {
    return { ok: false, httpStatus: res.status || undefined, message: "rerank response missing ranked results", errorKind: "invalid_json" };
  }

  return { ok: true, ranked };
}
