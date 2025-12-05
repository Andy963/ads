export interface SearchParams {
  query: string;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  lang?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  content?: string;
  snippet?: string;
  score?: number;
  source: string;
}

export interface SearchMeta {
  tookMs: number;
  total: number;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: SearchMeta;
}

export type SearchErrorType =
  | "config"
  | "input"
  | "timeout"
  | "quota"
  | "auth"
  | "network"
  | "internal"
  | "no_key";

export interface SearchError extends Error {
  type: SearchErrorType;
  cause?: unknown;
}

export function createSearchError(type: SearchErrorType, message: string, cause?: unknown): SearchError {
  const error = new Error(message) as SearchError;
  error.type = type;
  if (cause !== undefined) {
    (error as any).cause = cause;
  }
  return error;
}

export function isSearchError(value: unknown): value is SearchError {
  return value instanceof Error && typeof (value as Partial<SearchError>).type === "string";
}
