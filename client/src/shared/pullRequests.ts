export type PullRequestState = "open" | "closed" | "merged" | "all";
export type PullRequestInvolvement = "all" | "author" | "assignee" | "mentions" | "review-requested";
export type PullRequestChecks = "all" | "passing" | "failing" | "pending";

export type PullRequestSummary = {
  number: number;
  repository: string;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: string;
  updatedAt: string;
  createdAt: string;
  labels: Array<{ name: string; color: string }>;
  checks: "passing" | "failing" | "pending" | "unknown";
  additions: number;
  deletions: number;
  headRefName: string;
  baseRefName: string;
};

export type PullRequestListQuery = {
  projectId: string;
  state: PullRequestState;
  involvement: PullRequestInvolvement;
  labels: string[];
  author: string;
  checks: PullRequestChecks;
  cursor?: string;
  limit: number;
  refresh?: boolean;
};

export type PullRequestListResponse = {
  items: PullRequestSummary[];
  nextCursor: string | null;
  partial: boolean;
  error?: string;
  fetchedAt: number;
};

export type PullRequestDetail = PullRequestSummary & {
  body: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  checksDetail: Array<{
    name: string;
    status: string;
    conclusion: string;
    detailsUrl: string;
  }>;
  reviews: Array<{
    author: string;
    state: string;
    submittedAt: string;
  }>;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
  }>;
};

export type PullRequestDetailResponse = {
  item: PullRequestDetail | null;
  error?: string;
  fetchedAt: number;
};
