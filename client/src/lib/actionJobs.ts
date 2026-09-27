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
