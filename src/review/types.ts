export type ReviewStatus = "pending" | "running" | "approved" | "blocked" | "failed" | "skipped";

export type ReviewIssueSeverity = "error" | "warning";

export interface ReviewIssue {
  severity: ReviewIssueSeverity;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewReport {
  verdict: Exclude<ReviewStatus, "pending" | "running">;
  summary: string;
  issues: ReviewIssue[];
  notes?: string;
}

export interface ReviewTargetInfo {
  type: "working" | "commit";
  commit_ref?: string;
  commit_sha?: string;
  commit_summary?: string;
}

export interface ReviewState {
  workflow_id: string;
  status: ReviewStatus;
  requested_by?: string;
  requested_at?: string;
  updated_at?: string;
  skip_reason?: string;
  summary?: string;
  session_id?: string;
  report_path?: string;
  issues?: ReviewIssue[];
  verdict?: ReviewReport["verdict"];
  target?: ReviewTargetInfo;
}
