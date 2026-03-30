import type { TaskQueueMetricName, TaskQueueMetrics } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function normalizeNonNegativeInteger(raw: string | undefined, defaultValue: number): number {
  const parsed = Number(raw ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function resolveSessionTimeoutMsFromEnv(args: {
  timeoutMs?: string;
  timeoutHours?: string;
  defaultHours: number;
}): number {
  const timeoutMs = String(args.timeoutMs ?? "").trim();
  if (timeoutMs) {
    return normalizeNonNegativeInteger(timeoutMs, args.defaultHours * HOUR_MS);
  }
  const hours = normalizeNonNegativeInteger(args.timeoutHours, args.defaultHours);
  return hours * HOUR_MS;
}

function resolveCleanupIntervalMsFromEnv(args: {
  intervalMs?: string;
  intervalMinutes?: string;
  defaultMinutes: number;
}): number {
  const intervalMs = String(args.intervalMs ?? "").trim();
  if (intervalMs) {
    return normalizeNonNegativeInteger(intervalMs, args.defaultMinutes * MINUTE_MS);
  }
  const minutes = normalizeNonNegativeInteger(args.intervalMinutes, args.defaultMinutes);
  return minutes * MINUTE_MS;
}

export function resolveTaskQueueSessionTimeoutMs(): number {
  return resolveSessionTimeoutMsFromEnv({
    timeoutMs: process.env.ADS_TASK_QUEUE_SESSION_TIMEOUT_MS ?? process.env.ADS_WEB_SESSION_TIMEOUT_MS,
    timeoutHours:
      process.env.ADS_TASK_QUEUE_SESSION_TIMEOUT_HOURS ?? process.env.ADS_WEB_SESSION_TIMEOUT_HOURS,
    defaultHours: 24,
  });
}

export function resolveTaskQueueSessionCleanupIntervalMs(): number {
  return resolveCleanupIntervalMsFromEnv({
    intervalMs:
      process.env.ADS_TASK_QUEUE_SESSION_CLEANUP_INTERVAL_MS ??
      process.env.ADS_WEB_SESSION_CLEANUP_INTERVAL_MS,
    intervalMinutes:
      process.env.ADS_TASK_QUEUE_SESSION_CLEANUP_INTERVAL_MINUTES ??
      process.env.ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES,
    defaultMinutes: 5,
  });
}

export function summarizeReviewArtifactText(text: string): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "No reviewer summary provided.";
  }
  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.trim() ?? normalized;
  const summary = firstParagraph || normalized;
  return summary.length <= 400 ? summary : `${summary.slice(0, 399)}…`;
}

export function createTaskQueueMetrics(): TaskQueueMetrics {
  const names: TaskQueueMetricName[] = [
    "TASK_ADDED",
    "TASK_STARTED",
    "PROMPT_INJECTED",
    "TASK_COMPLETED",
    "INJECTION_SKIPPED",
  ];
  return {
    counts: Object.fromEntries(names.map((name) => [name, 0])) as Record<
      TaskQueueMetricName,
      number
    >,
    events: [],
  };
}

export function recordTaskQueueMetric(
  metrics: TaskQueueMetrics,
  name: TaskQueueMetricName,
  event?: { ts?: number; taskId?: string; reason?: string },
): void {
  metrics.counts[name] = (metrics.counts[name] ?? 0) + 1;
  metrics.events.push({
    name,
    ts: typeof event?.ts === "number" ? event.ts : Date.now(),
    taskId: event?.taskId,
    reason: event?.reason,
  });
  const maxEvents = 200;
  if (metrics.events.length > maxEvents) {
    metrics.events.splice(0, metrics.events.length - maxEvents);
  }
}

export function hashTaskId(taskId: string): number {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) return 0;
  const compact = normalized.replace(/-/g, "");
  const hex = compact.slice(0, 8);
  const parsed = Number.parseInt(hex, 16);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
