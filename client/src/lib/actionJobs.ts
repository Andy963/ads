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
