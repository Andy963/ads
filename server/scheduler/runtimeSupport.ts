import crypto from "node:crypto";
import path from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Runner, SqliteQueue } from "liteque";

import { getDatabaseInfo } from "../storage/database.js";
import { TaskStore } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { OrchestratorTaskExecutor } from "../tasks/executor.js";
import type { Logger } from "../utils/logger.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";

import { ScheduleStore } from "./store.js";
import type { StoredSchedule } from "./store.js";

export function renderIdempotencyKey(template: string, scheduleId: string, runAtIso: string): string {
  const normalized = String(template ?? "").trim();
  if (!normalized) {
    return `sch:${scheduleId}:${runAtIso}`;
  }
  const replaced = normalized.replaceAll("{scheduleId}", scheduleId).replaceAll("{runAtIso}", runAtIso);
  return replaced || `sch:${scheduleId}:${runAtIso}`;
}

export function buildExternalId(schedule: StoredSchedule, runAtMs: number): string {
  const runAtIso = new Date(runAtMs).toISOString();
  return renderIdempotencyKey(schedule.spec.policy.idempotencyKeyTemplate, schedule.id, runAtIso);
}

export type SchedulerJobPayload = {
  workspaceRoot: string;
  scheduleId: string;
  externalId: string;
  runAt: number;
};

export function buildEffectiveTaskPrompt(payload: SchedulerJobPayload, schedule: StoredSchedule): string {
  const runAtIso = new Date(payload.runAt).toISOString();
  const timezone = String(schedule.spec.schedule?.timezone ?? "").trim() || "UTC";
  const compiledPrompt = String(schedule.spec.compiledTask.prompt ?? "");
  return [
    "Scheduler runtime context:",
    `- scheduleId: ${schedule.id}`,
    `- externalId: ${payload.externalId}`,
    `- runAtIso: ${runAtIso}`,
    `- runAtMs: ${payload.runAt}`,
    `- timezone: ${timezone}`,
    `- idempotencyKey: ${payload.externalId}`,
    "",
    "Use the trigger values above as authoritative for this run.",
    "Do not ask the user for missing schedule trigger metadata when it is provided here.",
    "",
    compiledPrompt,
  ].join("\n");
}

export type SchedulerExecutionInput = {
  workspaceRoot: string;
  schedule: StoredSchedule;
  task: Task;
  signal: AbortSignal;
};

export type SchedulerExecutionResult = {
  resultSummary?: string;
};

export type SchedulerExecuteRun = (input: SchedulerExecutionInput) => Promise<SchedulerExecutionResult>;

export type SchedulerRuntimeLogger = Pick<Logger, "warn" | "debug" | "info">;

export type SchedulerWarningContext = {
  stage: string;
  workspaceRoot: string;
  scheduleId: string;
  externalId?: string | null;
  taskId?: string | null;
};

export type WorkspaceSchedulerState = {
  store: ScheduleStore;
  taskStore: TaskStore;
  queue: SqliteQueue<SchedulerJobPayload>;
  queueRawDb: SqliteDatabase;
  runner: Runner<SchedulerJobPayload, SchedulerExecutionResult>;
  executor: OrchestratorTaskExecutor;
  runnerPromise: Promise<void> | null;
  lastTouchedAt: number;
};

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
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildQueueName(workspaceRoot: string): string {
  const digest = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 12);
  return `ads_scheduler_v1_${digest}`;
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = String(workspaceRoot ?? "").trim();
  return detectWorkspaceFrom(normalized || process.cwd());
}

export function resolveLitequeDbPath(workspaceRoot: string): string {
  const base = getDatabaseInfo(workspaceRoot).path;
  const ext = path.extname(base);
  if (!ext) {
    return `${base}.liteque.db`;
  }
  return `${base.slice(0, -ext.length)}.liteque${ext}`;
}

export function generateAllocationId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export type LitequeDequeuedRow = {
  id: number;
  payload: string;
  priority: number;
  allocationId: string;
  numRunsLeft: number;
  maxNumRuns: number;
};

export function normalizeQuestions(questions: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    const trimmed = String(question ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function scheduleRequestsTelegramDelivery(schedule: StoredSchedule): boolean {
  return Array.isArray(schedule.spec.delivery?.channels) && schedule.spec.delivery.channels.includes("telegram");
}

export function resolveScheduleTelegramChatId(schedule: StoredSchedule): string | null {
  const chatId = String(schedule.spec.delivery?.telegram?.chatId ?? "").trim();
  return chatId || null;
}
