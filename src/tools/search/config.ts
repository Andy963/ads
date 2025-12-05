import path from "node:path";

import type { SearchError } from "./types.js";
import { createSearchError } from "./types.js";

export interface SearchConfig {
  apiKeys: string[];
  defaultMaxResults: number;
  maxResultsLimit: number;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  rps: number;
  logPath: string;
}

const DEFAULTS: Omit<SearchConfig, "apiKeys"> = {
  defaultMaxResults: 5,
  maxResultsLimit: 10,
  timeoutMs: 30_000,
  retries: 3,
  concurrency: 3,
  rps: 3,
  logPath: path.join("logs", "tavily-search.log"),
};

function parseEnvApiKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];

  const list = env.TAVILY_API_KEYS ?? "";
  for (const raw of list.split(",")) {
    const trimmed = raw.trim();
    if (trimmed) {
      keys.push(trimmed);
    }
  }

  const single = (env.TAVILY_API_KEY ?? "").trim();
  if (keys.length === 0 && single) {
    keys.push(single);
  }

  return keys;
}

export function resolveSearchConfig(
  overrides: Partial<Omit<SearchConfig, "apiKeys">> & { apiKeys?: string[] } = {},
  env: NodeJS.ProcessEnv = process.env,
): SearchConfig {
  const apiKeys = overrides.apiKeys ?? parseEnvApiKeys(env);

  const config: SearchConfig = {
    apiKeys,
    defaultMaxResults: overrides.defaultMaxResults ?? DEFAULTS.defaultMaxResults,
    maxResultsLimit: overrides.maxResultsLimit ?? DEFAULTS.maxResultsLimit,
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: overrides.retries ?? DEFAULTS.retries,
    concurrency: overrides.concurrency ?? DEFAULTS.concurrency,
    rps: overrides.rps ?? DEFAULTS.rps,
    logPath: overrides.logPath ?? DEFAULTS.logPath,
  };

  return config;
}

export function ensureApiKeys(config: SearchConfig): SearchError | null {
  if (config.apiKeys.length === 0) {
    return createSearchError("config", "Missing Tavily API key(s). Set TAVILY_API_KEYS or TAVILY_API_KEY.");
  }
  return null;
}
