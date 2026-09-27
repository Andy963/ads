export type ActionJobStatus =
  | "queued"
  | "running"
  | "verifying"
  | "reviewing"
  | "waiting_merge"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type ActionJobAttempt = {
  attempt: number;
  stage: string;
  failure: string;
  ts: number;
};

/**
 * The Actions panel row lists every recorded rework attempt, so malformed or
 * partial `attempts_json` payloads must not break the row.
 */
export function parseActionJobAttempts(value: string | null | undefined): ActionJobAttempt[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ActionJobAttempt => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as ActionJobAttempt).attempt === "number"
      && typeof (entry as ActionJobAttempt).stage === "string"
      && typeof (entry as ActionJobAttempt).failure === "string"
    ));
  } catch {
    return [];
  }
}

/**
 * While a job occupies the shared Actions session, user input would fire abort
 * signals into the running Developer turn, so the composer stays locked until
 * the job reaches a terminal (or human-attention) state.
 */
const ACTIONS_JOB_LOCKING_STATUSES: ReadonlySet<ActionJobStatus> = new Set([
  "running",
  "verifying",
  "reviewing",
  "waiting_merge",
]);

export function isActionJobLockingStatus(status: string): boolean {
  return ACTIONS_JOB_LOCKING_STATUSES.has(status as ActionJobStatus);
}

export function hasLockingActionJob(jobs: ReadonlyArray<{ status: string }>): boolean {
  return jobs.some((job) => isActionJobLockingStatus(job.status));
}

/**
 * Renders how long a blocked job has been waiting for a human. Jobs blocked
 * before `blocked_at` existed fall back to `updated_at` so the row still
 * reports a duration instead of an empty gap.
 */
export function formatBlockedDuration(
  blockedAt: number | null | undefined,
  now: number,
  fallbackUpdatedAt?: number | null,
): string | null {
  const start = typeof blockedAt === "number" && Number.isFinite(blockedAt)
    ? blockedAt
    : typeof fallbackUpdatedAt === "number" && Number.isFinite(fallbackUpdatedAt)
      ? fallbackUpdatedAt
      : null;
  if (start === null) return null;

  const totalMinutes = Math.max(0, Math.floor((now - start) / 60000));
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const remainder = totalMinutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}
