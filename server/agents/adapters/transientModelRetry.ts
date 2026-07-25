import type { AgentEvent } from "../../codex/events.js";
import type { ThreadEvent, ThreadItem } from "../protocol/types.js";
import { isAbortError } from "../../utils/abort.js";

export const TRANSIENT_MODEL_RETRY_COUNT_ENV = "ADS_UPSTREAM_RETRY_COUNT";
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;
const RATE_LIMIT_BACKOFF_CYCLE_SIZE = 5;
const RATE_LIMIT_BACKOFF_STEP_MS = 1_000;

function randomBackoffMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export interface TransientModelRetryOptions {
  agentName: string;
  backoffMs?: readonly number[];
  signal?: AbortSignal;
  log?: (message: string) => void;
  onRetry?: (notice: TransientModelRetryNotice) => void;
}

export interface TransientModelRetryNotice {
  message: string;
  retryCount: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface RetryAttemptState {
  readonly attempt: number;
  markSideEffect(event: AgentEvent | ThreadEvent | ThreadItem | null | undefined): void;
}

export class TransientModelRetryAttemptError extends Error {
  readonly retryable: boolean;
  readonly sideEffectObserved: boolean;

  constructor(message: string, options: { retryable: boolean; sideEffectObserved: boolean; cause?: unknown }) {
    super(message);
    this.name = "TransientModelRetryAttemptError";
    this.retryable = options.retryable;
    this.sideEffectObserved = options.sideEffectObserved;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class TransientModelRetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(message: string, options: { attempts: number; cause?: unknown }) {
    super(message);
    this.name = "TransientModelRetryExhaustedError";
    this.attempts = options.attempts;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function createTransientModelRetryEvent(notice: TransientModelRetryNotice): AgentEvent {
  return {
    phase: "connection",
    title: "模型请求重试",
    detail: notice.message,
    timestamp: Date.now(),
    raw: { type: "error", message: notice.message } as ThreadEvent,
    retry: {
      source: "external",
      retryCount: notice.retryCount,
      nextAttempt: notice.nextAttempt,
      maxAttempts: notice.maxAttempts,
      delayMs: notice.delayMs,
    },
  };
}

export function isTransientByokCapacityError(message: string): boolean {
  void message;
  return false;
}

export function isClaudeServiceUnavailable429(message: string): boolean {
  return isHttp429UpstreamError(message);
}

export function isHighDemandUpstreamError(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("we're currently experiencing high demand") ||
    normalized.includes("we are currently experiencing high demand") ||
    (normalized.includes("high demand") && normalized.includes("temporary errors"))
  );
}

export function isHttp429UpstreamError(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|[^0-9])429(?:[^0-9]|$)/.test(normalized);
}

export function isHttp503UpstreamError(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return (
    /(?:^|[^0-9])503(?:[^0-9]|$)/.test(normalized) &&
    normalized.includes("service unavailable")
  );
}

export function isBadResponseStatusCode400UpstreamError(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("bad_response_status_code") &&
    normalized.includes("bad response status code 400")
  );
}

export function isClaudeSafeguardError(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  if (!/\bfable(?:\s+\d+)?\b/.test(normalized)) return false;
  return (
    normalized.includes("safeguards flagged this message") ||
    /claude code can['’]t respond to this request with fable(?:\s+\d+)?/.test(normalized)
  );
}

export function isTransientUpstreamModelError(message: string): boolean {
  return (
    isHighDemandUpstreamError(message) ||
    isHttp429UpstreamError(message) ||
    isHttp503UpstreamError(message) ||
    isBadResponseStatusCode400UpstreamError(message) ||
    isClaudeSafeguardError(message)
  );
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function resolveTransientModelRetryMaxAttempts(): number {
  const retryCount = parseNonNegativeInteger(process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV]) ?? DEFAULT_RETRY_COUNT;
  return retryCount + 1;
}

function exponentialBackoffMs(attempt: number): number {
  const cap = Math.min(DEFAULT_BACKOFF_CAP_MS, DEFAULT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return randomBackoffMs(Math.floor(cap / 2), cap);
}

function parseRetryAfterMs(message: string, now: number = Date.now()): number | null {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const numericMatch =
    normalized.match(/retry[-_ ]after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i) ??
    normalized.match(/"retry_after"\s*:\s*(\d+(?:\.\d+)?)/i) ??
    normalized.match(/\bretry after\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\b/i);
  if (numericMatch) {
    const seconds = Number(numericMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
  }

  const dateMatch = normalized.match(/retry[-_ ]after["']?\s*[:=]\s*["']([^"',}\]]+)/i);
  if (!dateMatch) return null;
  const timestamp = Date.parse(dateMatch[1].trim());
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

export function rateLimitCyclicBackoffMs(attempt: number): number {
  const cycleAttempt = ((Math.max(1, attempt) - 1) % RATE_LIMIT_BACKOFF_CYCLE_SIZE) + 1;
  return randomBackoffMs(
    cycleAttempt * RATE_LIMIT_BACKOFF_STEP_MS,
    (cycleAttempt + 1) * RATE_LIMIT_BACKOFF_STEP_MS,
  );
}

export function resolveTransientRetryDelayMs(options: {
  message: string;
  attempt: number;
  backoffMs?: readonly number[];
  now?: number;
}): number {
  if (options.backoffMs) {
    return Math.max(0, options.backoffMs[Math.min(options.attempt - 1, options.backoffMs.length - 1)] ?? 0);
  }

  if (isHttp429UpstreamError(options.message)) {
    return parseRetryAfterMs(options.message, options.now) ?? rateLimitCyclicBackoffMs(options.attempt);
  }

  return exponentialBackoffMs(options.attempt);
}

export function isSideEffectItem(item: ThreadItem | null | undefined): boolean {
  if (!item) return false;
  return item.type === "command_execution" || item.type === "file_change" || item.type === "tool_call" || item.type === "subagent_dispatch";
}

export function eventHasSideEffect(event: AgentEvent | ThreadEvent | ThreadItem | null | undefined): boolean {
  if (!event) return false;
  if (isThreadItem(event)) {
    return isSideEffectItem(event);
  }
  const raw = (event as AgentEvent).raw;
  if (raw && typeof raw === "object") {
    return eventHasSideEffect(raw as ThreadEvent);
  }
  const type = (event as { type?: unknown }).type;
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    return isSideEffectItem((event as { item?: ThreadItem }).item);
  }
  return false;
}

export async function runWithTransientModelRetry<T>(
  options: TransientModelRetryOptions,
  runAttempt: (state: RetryAttemptState) => Promise<T>,
): Promise<T> {
  const maxAttempts = resolveTransientModelRetryMaxAttempts();
  const backoffMs = options.backoffMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sideEffectObserved = false;
    const state: RetryAttemptState = {
      attempt,
      markSideEffect(event) {
        if (eventHasSideEffect(event)) {
          sideEffectObserved = true;
        }
      },
    };

    try {
      return await runAttempt(state);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof TransientModelRetryAttemptError
          ? error.retryable
          : isTransientUpstreamModelError(message);
      const unsafe =
        sideEffectObserved ||
        (error instanceof TransientModelRetryAttemptError && error.sideEffectObserved);

      lastError = error;
      if (!retryable || unsafe) {
        throw error;
      }
      if (attempt >= maxAttempts) {
        throw new TransientModelRetryExhaustedError(message, { attempts: attempt, cause: error });
      }

      const delayMs = resolveTransientRetryDelayMs({ message, attempt, backoffMs });
      const notice: TransientModelRetryNotice = {
        message,
        retryCount: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
      };
      try {
        options.onRetry?.(notice);
      } catch (callbackError) {
        options.log?.(
          `[${options.agentName}] failed to publish retry notice: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
        );
      }
      options.log?.(
        `[${options.agentName}] transient upstream model error; retrying attempt ${attempt + 1}/${maxAttempts} after ${delayMs}ms`,
      );
      await delay(delayMs, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isThreadItem(value: unknown): value is ThreadItem {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "command_execution" ||
    type === "file_change" ||
    type === "tool_call" ||
    type === "web_search" ||
    type === "todo_list" ||
    type === "agent_message" ||
    type === "reasoning" ||
    type === "error" ||
    type === "subagent_dispatch"
  );
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  let abort: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  }).finally(() => {
    if (signal && abort) {
      signal.removeEventListener("abort", abort);
    }
  });
}
