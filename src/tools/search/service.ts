import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ApiKeyManager } from "./keyManager.js";
import { RateLimiter } from "./rateLimiter.js";
import { resolveSearchConfig, ensureApiKeys } from "./config.js";
import { callTavilyWithTimeout, createTavilyClient } from "./client.js";
import type { TavilyClientAdapter } from "./client.js";
import {
  createSearchError,
  isSearchError,
  type SearchError,
  type SearchErrorType,
  type SearchParams,
  type SearchResponse,
  type SearchResult,
} from "./types.js";

export interface SearchOptions {
  config?: ReturnType<typeof resolveSearchConfig>;
  clientFactory?: (apiKey: string) => Promise<TavilyClientAdapter>;
}

interface LogEntry {
  timestamp: string;
  query: string;
  keyIndex: number;
  durationMs: number;
  resultCount?: number;
  errorType?: SearchErrorType;
  message?: string;
}

const QUERY_LOG_LIMIT = 120;

function truncate(value: string, limit = QUERY_LOG_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function normalizeResults(raw: Record<string, unknown>): SearchResult[] {
  const rawResults = raw.results;
  const items = Array.isArray(rawResults) ? rawResults : [];

  return items.map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const title = typeof record.title === "string"
      ? record.title
      : typeof record.url === "string"
        ? record.url
        : "Untitled";
    const url = typeof record.url === "string" ? record.url : "";
    const contentCandidate = record.content ?? record.snippet ?? record.result;
    const snippetCandidate = record.snippet ?? record.content ?? record.result;
    return {
      title,
      url,
      content: typeof contentCandidate === "string" ? contentCandidate : undefined,
      snippet: typeof snippetCandidate === "string" ? snippetCandidate : undefined,
      score: typeof record.score === "number" ? record.score : undefined,
    source: "tavily",
    };
  });
}

function buildPayload(params: SearchParams, maxResults: number): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    query: params.query,
    maxResults,
  };
  if (params.includeDomains && params.includeDomains.length > 0) {
    payload.includeDomains = params.includeDomains;
  }
  if (params.excludeDomains && params.excludeDomains.length > 0) {
    payload.excludeDomains = params.excludeDomains;
  }
  if (params.lang) {
    payload.lang = params.lang;
  }
  return payload;
}

async function appendLog(entry: LogEntry, logPath: string): Promise<void> {
  try {
    const dir = path.dirname(logPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8" });
  } catch {
    // Logging failures should not break the main flow.
  }
}

function classifyError(error: unknown): { type: SearchErrorType; retryable: boolean; shouldSwitchKey: boolean; message: string } {
  if (isSearchError(error)) {
    const retryable = !["input", "config", "no_key"].includes(error.type);
    const shouldSwitchKey = ["auth", "quota", "network", "timeout", "internal"].includes(error.type);
    return { type: error.type, retryable, shouldSwitchKey, message: error.message };
  }

  const anyErr = error as { code?: string; message?: string; response?: { status?: number }; status?: number };
  const status = anyErr.response?.status ?? anyErr.status;
  const message = anyErr.message ?? "Tavily search failed";

  if (status === 400) return { type: "input", retryable: false, shouldSwitchKey: false, message };
  if (status === 401 || status === 403) return { type: "auth", retryable: true, shouldSwitchKey: true, message };
  if (status === 429) return { type: "quota", retryable: true, shouldSwitchKey: true, message };
  if (status && status >= 500) return { type: "network", retryable: true, shouldSwitchKey: true, message };

  if (anyErr.code === "ECONNREFUSED" || anyErr.code === "ECONNRESET" || anyErr.code === "ENOTFOUND") {
    return { type: "network", retryable: true, shouldSwitchKey: true, message };
  }
  if (anyErr.code === "ETIMEDOUT") {
    return { type: "timeout", retryable: true, shouldSwitchKey: true, message };
  }

  return { type: "internal", retryable: true, shouldSwitchKey: true, message };
}

export async function search(params: SearchParams, options: SearchOptions = {}): Promise<SearchResponse> {
  if (!params?.query || typeof params.query !== "string" || !params.query.trim()) {
    throw createSearchError("input", "Query is required");
  }

  const config = options.config ?? resolveSearchConfig();
  const missingKeys = ensureApiKeys(config);
  if (missingKeys) {
    throw missingKeys;
  }

  const maxResults = Math.min(config.maxResultsLimit, params.maxResults ?? config.defaultMaxResults);
  const payload = buildPayload({ ...params, maxResults }, maxResults);

  const limiter = new RateLimiter({ concurrency: config.concurrency, rps: config.rps });
  const keyManager = new ApiKeyManager(config.apiKeys);
  const clientFactory = options.clientFactory ?? ((key: string) => createTavilyClient(key));

  let attempt = 0;
  const maxAttempts = Math.max(1, config.retries + 1);
  let lastError: SearchError | null = null;

  while (attempt < maxAttempts) {
    const currentKey = keyManager.getCurrent();
    if (!currentKey) {
      throw createSearchError("config", "No Tavily API key available");
    }

    const started = performance.now();
    try {
      const client = await clientFactory(currentKey.key);
      const { response, error } = await limiter.schedule(() => callTavilyWithTimeout(client, payload, config.timeoutMs));

      if (error) {
        throw error;
      }

      const durationMs = Math.round(performance.now() - started);
      const results = normalizeResults(response ?? {});
      const total = Array.isArray(response?.results) ? response.results.length : results.length;
      const limitedResults = results.slice(0, maxResults);

      await appendLog(
        {
          timestamp: new Date().toISOString(),
          query: truncate(params.query),
          keyIndex: currentKey.index,
          durationMs,
          resultCount: limitedResults.length,
        },
        config.logPath,
      );

      return {
        results: limitedResults,
        meta: { tookMs: durationMs, total },
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const classified = classifyError(error);
      lastError = createSearchError(classified.type, classified.message, error);

      await appendLog(
        {
          timestamp: new Date().toISOString(),
          query: truncate(params.query),
          keyIndex: currentKey.index,
          durationMs,
          errorType: classified.type,
          message: classified.message,
        },
        config.logPath,
      );

      attempt += 1;
      if (!classified.retryable || attempt >= maxAttempts) {
        throw lastError;
      }

      if (classified.shouldSwitchKey) {
        const next = keyManager.moveToNext();
        if (!next) {
          // No more keys; continue retrying on the current key if attempts remain.
          continue;
        }
      }
    }
  }

  throw lastError ?? createSearchError("internal", "Tavily search failed");
}
