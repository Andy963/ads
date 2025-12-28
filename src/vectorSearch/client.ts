import { createLogger } from "../utils/logger.js";
import type { VectorQueryResponse, VectorUpsertItem } from "./types.js";

const logger = createLogger("VectorSearchClient");

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/g, "");
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

