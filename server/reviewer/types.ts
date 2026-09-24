export interface ReviewPayload {
  issue: {
    id?: number | null;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
  };
  diffRange?: {
    baseRef: string;
    headRef: string;
    baseCommit?: string;
    headCommit?: string;
    range: string;
  };
  adrs?: Array<{
    id: string;
    title: string;
    decision: string;
  }>;
  diff: string;
  diffStat?: string;
  diffCaptureError?: string;
  testReport?: {
    command: string;
    exitCode: number;
    summary: string;
    output?: string;
  };
}

export interface ReviewDefect {
  file: string;
  line?: number;
  severity: "blocker" | "warning";
  description: string;
}

export interface ReviewVerdict {
  status: "PASS" | "REJECT";
  summary: string;
  defects: ReviewDefect[];
  reviewerProfileId?: string;
  reviewedAt: number;
}
