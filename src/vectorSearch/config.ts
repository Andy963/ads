import { createLogger } from "../utils/logger.js";

const logger = createLogger("VectorSearchConfig");

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface VectorSearchConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  topK: number;
  maxTopK: number;
  maxQueryChars: number;
  namespaces: string[];
  timeoutMs: number;
  upsertBatchSize: number;
  historyScanLimit: number;
  chunkMaxChars: number;
  chunkOverlapChars: number;
}

export interface VectorSearchConfigLoadResult {
  config: VectorSearchConfig | null;
  error?: string;
}

export function loadVectorSearchConfig(): VectorSearchConfigLoadResult {
  const enabled = parseBoolean(process.env.ADS_VECTOR_SEARCH_ENABLED) ?? false;
  if (!enabled) {
    return { config: null, error: "vector search is disabled (set ADS_VECTOR_SEARCH_ENABLED=1)" };
  }

  const baseUrl = (process.env.ADS_VECTOR_SEARCH_URL ?? "").trim().replace(/\/+$/g, "");
  const token = (process.env.ADS_VECTOR_SEARCH_TOKEN ?? "").trim();
  if (!baseUrl) {
    return { config: null, error: "missing ADS_VECTOR_SEARCH_URL" };
  }
  if (!token) {
    return { config: null, error: "missing ADS_VECTOR_SEARCH_TOKEN" };
  }

  const topK = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_TOPK, 8);
  const maxTopK = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_MAX_TOPK, 50);
  const maxQueryChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_MAX_QUERY_CHARS, 8000);
  const timeoutMs = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_TIMEOUT_MS, 15_000);
  const upsertBatchSize = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_UPSERT_BATCH_SIZE, 64);
  const historyScanLimit = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_HISTORY_SCAN_LIMIT, 800);

  const namespaces = parseCsv(process.env.ADS_VECTOR_SEARCH_NAMESPACES);
  const effectiveNamespaces = namespaces.length ? namespaces : ["cli", "web", "telegram"];

  const chunkMaxChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_CHUNK_MAX_CHARS, 1600);
  const chunkOverlapChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_CHUNK_OVERLAP_CHARS, 200);

  if (chunkOverlapChars >= chunkMaxChars) {
    logger.warn(
      `[VectorSearchConfig] chunk overlap (${chunkOverlapChars}) >= chunk max (${chunkMaxChars}); using max/4 overlap`,
    );
  }

  return {
    config: {
      enabled: true,
      baseUrl,
      token,
      topK: Math.max(1, Math.min(topK, maxTopK)),
      maxTopK: Math.max(1, maxTopK),
      maxQueryChars: Math.max(1, maxQueryChars),
      namespaces: effectiveNamespaces,
      timeoutMs,
      upsertBatchSize,
      historyScanLimit,
      chunkMaxChars,
      chunkOverlapChars: Math.min(chunkOverlapChars, Math.floor(chunkMaxChars / 4)),
    },
  };
}
