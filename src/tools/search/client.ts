import { createSearchError } from "./types.js";
import type { SearchError, SearchErrorType } from "./types.js";

export interface TavilyClientAdapter {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ClientResult {
  response?: Record<string, unknown>;
  error?: SearchError;
}

type TavilyClientCtor = new (opts: { apiKey: string }) => TavilyClientAdapter;

async function loadTavilyCtor(): Promise<TavilyClientCtor> {
  try {
    const mod = await import("@tavily/core");
    // 模块可能导出 TavilyClient 或作为 default
    const modRecord = mod as Record<string, unknown>;
    const ctor = (modRecord.TavilyClient ?? modRecord.default) as TavilyClientCtor | undefined;
    if (!ctor) {
      throw new Error("TavilyClient export not found");
    }
    return ctor;
  } catch (error) {
    const err = createSearchError(
      "config",
      "Missing dependency @tavily/core. Please install it to enable Tavily search.",
      error,
    );
    throw err;
  }
}

export async function createTavilyClient(apiKey: string): Promise<TavilyClientAdapter> {
  const Ctor = await loadTavilyCtor();
  return new Ctor({ apiKey }) as TavilyClientAdapter;
}

function classifyError(error: unknown): { type: SearchErrorType; retryable: boolean; shouldSwitchKey: boolean; message: string } {
  if ((error as SearchError)?.type) {
    const typed = error as SearchError;
    const retryable = !["input", "config", "no_key"].includes(typed.type);
    const shouldSwitchKey = ["auth", "quota", "network", "timeout", "internal"].includes(typed.type);
    return { type: typed.type, retryable, shouldSwitchKey, message: typed.message };
  }

  const anyErr = error as { code?: string; message?: string; response?: { status?: number }; status?: number };
  const status = anyErr.response?.status ?? anyErr.status;
  const message = anyErr.message ?? "Tavily request failed";

  if (status === 400) return { type: "input", retryable: false, shouldSwitchKey: false, message };
  if (status === 401 || status === 403) return { type: "auth", retryable: true, shouldSwitchKey: true, message };
  if (status === 429) return { type: "quota", retryable: true, shouldSwitchKey: true, message };
  if (status && status >= 500) return { type: "network", retryable: true, shouldSwitchKey: true, message };
  if (anyErr.code === "MODULE_NOT_FOUND") {
    return { type: "config", retryable: false, shouldSwitchKey: false, message };
  }
  if (anyErr.code === "ECONNREFUSED" || anyErr.code === "ECONNRESET" || anyErr.code === "ENOTFOUND") {
    return { type: "network", retryable: true, shouldSwitchKey: true, message };
  }
  if (anyErr.code === "ETIMEDOUT") {
    return { type: "timeout", retryable: true, shouldSwitchKey: true, message };
  }

  return { type: "internal", retryable: true, shouldSwitchKey: true, message };
}

export async function callTavilyWithTimeout(
  client: TavilyClientAdapter,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ClientResult> {
  try {
    // The official SDK may not support AbortController; timeout is enforced by race.
    const response = await Promise.race([
      client.search(payload),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(createSearchError("timeout", "Tavily search timed out")), timeoutMs);
      }),
    ]);
    return { response };
  } catch (error) {
    const classified = classifyError(error);
    return { error: createSearchError(classified.type, classified.message, error) };
  }
}
