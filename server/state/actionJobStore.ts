import type { Database as DatabaseType } from "better-sqlite3";

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

export type ActionJobKind = "github_issue" | "local_prompt" | "pull_request_review";

export interface ActionJobIssueSnapshot {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  adrs: Array<{ id: string; title: string; decision: string }>;
}

export interface ActionJobAttempt {
  attempt: number;
  stage: string;
  failure: string;
  ts: number;
}

export interface ActionJobRecord {
  id: string;
  project_id: string;
  lane_generation: number;
  job_kind: ActionJobKind;
  issue_id: number | null;
  issue_title: string;
  issue_snapshot_json: string;
  verification_report_json: string;
  status: ActionJobStatus;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  developer_profile_id: string | null;
  reviewer_profile_ids_json: string;
  current_step: string | null;
  steps_json: string;
  review_verdicts_json: string;
  attempts_json: string;
  pr_number: number | null;
  pr_url: string | null;
  error_message: string | null;
  rework_count: number;
  blocked_at: number | null;
  auth_user_id: string | null;
  chat_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getActionJobs(
  db: DatabaseType,
  projectId: string,
  status?: ActionJobStatus,
  authUserId?: string,
): ActionJobRecord[] {
  const owner = String(authUserId ?? "").trim();
  const ownerClause = owner ? " AND auth_user_id = ?" : "";
  const ownerParams = owner ? [owner] : [];
  if (status) {
    return db
      .prepare(`SELECT * FROM action_jobs WHERE project_id = ? AND status = ?${ownerClause} ORDER BY created_at ASC`)
      .all(projectId, status, ...ownerParams) as ActionJobRecord[];
  }
  return db
    .prepare(`SELECT * FROM action_jobs WHERE project_id = ?${ownerClause} ORDER BY created_at DESC`)
    .all(projectId, ...ownerParams) as ActionJobRecord[];
}

export function getActionJobById(db: DatabaseType, id: string): ActionJobRecord | null {
  return (db.prepare(`SELECT * FROM action_jobs WHERE id = ?`).get(id) as ActionJobRecord | undefined) ?? null;
}

export function createActionJob(
  db: DatabaseType,
  job: {
    id: string;
    project_id: string;
    lane_generation?: number;
    job_kind: ActionJobKind;
    issue_id: number;
    issue_title: string;
    issue_snapshot: ActionJobIssueSnapshot;
    status?: ActionJobStatus;
    branch: string;
    base_sha: string;
    head_sha: string;
    reviewer_profile_ids_json: string;
    pr_number: number;
    pr_url: string;
    auth_user_id: string;
    chat_session_id: string;
  },
  now = Date.now(),
): ActionJobRecord {
  const status = job.status ?? "queued";
  const laneGeneration = Math.max(1, Math.floor(job.lane_generation ?? 1));
  const issueSnapshotJson = JSON.stringify(job.issue_snapshot);
  db.prepare(`
    INSERT INTO action_jobs (
      id, project_id, lane_generation, job_kind, issue_id, issue_title, issue_snapshot_json,
      verification_report_json, status, branch, base_sha, head_sha, reviewer_profile_ids_json,
      current_step, steps_json, review_verdicts_json, attempts_json, pr_number, pr_url,
      error_message, rework_count, blocked_at, auth_user_id, chat_session_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, NULL, '[]', '[]', '[]', ?, ?, NULL, 0, NULL, ?, ?, ?, ?)
  `).run(
    job.id,
    job.project_id,
    laneGeneration,
    job.job_kind,
    job.issue_id,
    job.issue_title,
    issueSnapshotJson,
    status,
    job.branch,
    job.base_sha,
    job.head_sha,
    job.reviewer_profile_ids_json,
    job.pr_number,
    job.pr_url,
    job.auth_user_id,
    job.chat_session_id,
    now,
    now,
  );
  return getActionJobById(db, job.id)!;
}

export function updateActionJobStatus(
  db: DatabaseType,
  id: string,
  status: ActionJobStatus,
  updates: Partial<Pick<ActionJobRecord,
    "current_step" | "review_verdicts_json" | "verification_report_json" | "error_message">> = {},
  now = Date.now(),
): void {
  const fields = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [status, now];
  for (const field of ["current_step", "review_verdicts_json", "verification_report_json", "error_message"] as const) {
    if (!(field in updates)) continue;
    fields.push(`${field} = ?`);
    const fallback = field === "verification_report_json" ? "" : field === "review_verdicts_json" ? "[]" : null;
    values.push(updates[field] ?? fallback);
  }
  values.push(id);
  db.prepare(`UPDATE action_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}
