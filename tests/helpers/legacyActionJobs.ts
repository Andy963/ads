import type { Database as DatabaseType } from "better-sqlite3";

import type { ActionJobStatus } from "../../server/state/actionJobStore.js";

export function insertLegacyActionJob(
  db: DatabaseType,
  job: {
    id: string;
    project_id: string;
    issue_id?: number | null;
    issue_title: string;
    status?: ActionJobStatus;
    branch?: string | null;
    head_sha?: string | null;
    auth_user_id?: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO action_jobs (
      id, project_id, lane_generation, job_kind, issue_id, issue_title, issue_snapshot_json,
      status, branch, base_sha, head_sha, developer_profile_id, reviewer_profile_ids_json,
      current_step, steps_json, review_verdicts_json, attempts_json, pr_number, pr_url,
      error_message, rework_count, blocked_at, auth_user_id, chat_session_id, created_at, updated_at
    ) VALUES (?, ?, 1, 'github_issue', ?, ?, ?, ?, ?, NULL, ?, NULL, '[]', NULL, '[]', '[]', '[]', NULL, NULL, NULL, 0, NULL, ?, NULL, ?, ?)
  `).run(
    job.id,
    job.project_id,
    job.issue_id ?? null,
    job.issue_title,
    JSON.stringify({ title: job.issue_title, description: "", acceptanceCriteria: [], adrs: [] }),
    job.status ?? "completed",
    job.branch ?? null,
    job.head_sha ?? null,
    job.auth_user_id ?? null,
    now,
    now,
  );
}
