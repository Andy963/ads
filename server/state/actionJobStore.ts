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

export type ActionJobKind = "github_issue" | "local_prompt";

export interface ActionJobRecord {
  id: string;
  project_id: string;
  job_kind: ActionJobKind;
  issue_id: number | null;
  issue_title: string;
  status: ActionJobStatus;
  branch: string | null;
  developer_profile_id: string | null;
  reviewer_profile_ids_json: string;
  current_step: string | null;
  steps_json: string;
  review_verdicts_json: string;
  pr_number: number | null;
  pr_url: string | null;
  error_message: string | null;
  rework_count: number;
  created_at: number;
  updated_at: number;
}

export function getActionJobs(db: DatabaseType, projectId: string, status?: ActionJobStatus): ActionJobRecord[] {
  if (status) {
    return db
      .prepare(`SELECT * FROM action_jobs WHERE project_id = ? AND status = ? ORDER BY created_at ASC`)
      .all(projectId, status) as ActionJobRecord[];
  }
  return db
    .prepare(`SELECT * FROM action_jobs WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as ActionJobRecord[];
}

export function getActionJobById(db: DatabaseType, id: string): ActionJobRecord | null {
  return (db.prepare(`SELECT * FROM action_jobs WHERE id = ?`).get(id) as ActionJobRecord | undefined) ?? null;
}

export function createActionJob(
  db: DatabaseType,
  job: {
    id: string;
    project_id: string;
    job_kind?: ActionJobKind;
    issue_id?: number | null;
    issue_title: string;
    status?: ActionJobStatus;
    branch?: string | null;
    developer_profile_id?: string | null;
    reviewer_profile_ids_json?: string;
  },
  now = Date.now(),
): ActionJobRecord {
  const status: ActionJobStatus = job.status ?? "queued";
  const kind: ActionJobKind = job.job_kind ?? "github_issue";
  const issueId = job.issue_id ?? null;
  const branch = job.branch ?? null;
  const devProfileId = job.developer_profile_id ?? null;
  const reviewerProfilesJson = job.reviewer_profile_ids_json ?? "[]";

  db.prepare(`
    INSERT INTO action_jobs
      (id, project_id, job_kind, issue_id, issue_title, status, branch,
       developer_profile_id, reviewer_profile_ids_json, current_step, steps_json,
       review_verdicts_json, pr_number, pr_url, error_message, rework_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', '[]', NULL, NULL, NULL, 0, ?, ?)
  `).run(
    job.id,
    job.project_id,
    kind,
    issueId,
    job.issue_title,
    status,
    branch,
    devProfileId,
    reviewerProfilesJson,
    now,
    now,
  );

  return {
    id: job.id,
    project_id: job.project_id,
    job_kind: kind,
    issue_id: issueId,
    issue_title: job.issue_title,
    status,
    branch,
    developer_profile_id: devProfileId,
    reviewer_profile_ids_json: reviewerProfilesJson,
    current_step: null,
    steps_json: "[]",
    review_verdicts_json: "[]",
    pr_number: null,
    pr_url: null,
    error_message: null,
    rework_count: 0,
    created_at: now,
    updated_at: now,
  };
}

export function updateActionJobStatus(
  db: DatabaseType,
  id: string,
  status: ActionJobStatus,
  updates: Partial<Pick<ActionJobRecord, "current_step" | "steps_json" | "review_verdicts_json" | "pr_number" | "pr_url" | "error_message" | "branch" | "rework_count">> = {},
  now = Date.now(),
): void {
  const fields = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [status, now];

  if ("current_step" in updates) {
    fields.push("current_step = ?");
    values.push(updates.current_step ?? null);
  }
  if ("steps_json" in updates) {
    fields.push("steps_json = ?");
    values.push(updates.steps_json ?? "[]");
  }
  if ("review_verdicts_json" in updates) {
    fields.push("review_verdicts_json = ?");
    values.push(updates.review_verdicts_json ?? "[]");
  }
  if ("pr_number" in updates) {
    fields.push("pr_number = ?");
    values.push(updates.pr_number ?? null);
  }
  if ("pr_url" in updates) {
    fields.push("pr_url = ?");
    values.push(updates.pr_url ?? null);
  }
  if ("error_message" in updates) {
    fields.push("error_message = ?");
    values.push(updates.error_message ?? null);
  }
  if ("branch" in updates) {
    fields.push("branch = ?");
    values.push(updates.branch ?? null);
  }
  if ("rework_count" in updates) {
    fields.push("rework_count = ?");
    values.push(Math.max(0, Math.floor(updates.rework_count ?? 0)));
  }

  values.push(id);
  db.prepare(`UPDATE action_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteActionJobsByProject(db: DatabaseType, projectId: string): number {
  const result = db.prepare(`DELETE FROM action_jobs WHERE project_id = ?`).run(projectId) as { changes?: number };
  return result?.changes ?? 0;
}
