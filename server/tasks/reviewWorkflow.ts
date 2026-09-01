import type { CreateTaskInput, Task, TaskCategory } from "./types.js";

export type PullRequestReference = {
  number: number;
  url: string | null;
};

export type ReviewDecision = {
  status: "approved" | "rejected";
  feedback: string;
};

const PR_URL_PATTERN = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)(?:[^\s]*)?/i;
const PR_LABEL_PATTERN = /\b(?:PR|pull request)\s*#?\s*(\d+)\b/i;
const ISSUE_PATTERN = /\bIssue\s*#\s*(\d+)\b/i;
const REVIEW_STATUS_PATTERN = /^\s*REVIEW_STATUS\s*:\s*(approved|rejected)\s*$/im;
const REVIEW_FEEDBACK_PATTERN = /^\s*REVIEW_FEEDBACK\s*:\s*(.*?)\s*$/ims;

export function extractPullRequestReference(text: string): PullRequestReference | null {
  const raw = String(text ?? "");
  const urlMatch = PR_URL_PATTERN.exec(raw);
  if (urlMatch?.[1]) {
    return { number: Number(urlMatch[1]), url: urlMatch[0] };
  }
  const labelMatch = PR_LABEL_PATTERN.exec(raw);
  if (labelMatch?.[1]) {
    return { number: Number(labelMatch[1]), url: null };
  }
  return null;
}

export function extractIssueNumber(text: string): number | null {
  const match = ISSUE_PATTERN.exec(String(text ?? ""));
  return match?.[1] ? Number(match[1]) : null;
}

export function parseReviewDecision(result: string): ReviewDecision | null {
  const status = REVIEW_STATUS_PATTERN.exec(String(result ?? ""))?.[1]?.toLowerCase();
  if (status !== "approved" && status !== "rejected") {
    return null;
  }
  const feedback = REVIEW_FEEDBACK_PATTERN.exec(String(result ?? ""))?.[1]?.trim() ?? "";
  return { status, feedback };
}

export function findPullRequestInTaskChain(
  task: Task,
  getTask: (id: string) => Task | null,
  maxDepth = 8,
): PullRequestReference | null {
  let current: Task | null = task;
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    const reference = extractPullRequestReference(`${current.title}\n${current.prompt}\n${current.result ?? ""}`);
    if (reference) return reference;
    const parentId = String(current.parentTaskId ?? "").trim();
    current = parentId ? getTask(parentId) : null;
  }
  return null;
}

export function findIssueNumberInTaskChain(
  task: Task,
  getTask: (id: string) => Task | null,
  maxDepth = 8,
): number | null {
  let current: Task | null = task;
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    const issueNumber = extractIssueNumber(`${current.title}\n${current.prompt}\n${current.result ?? ""}`);
    if (issueNumber != null) return issueNumber;
    const parentId = String(current.parentTaskId ?? "").trim();
    current = parentId ? getTask(parentId) : null;
  }
  return null;
}

export function buildReviewTaskInput(args: {
  source: Task;
  pullRequest: PullRequestReference;
  issueNumber?: number | null;
}): CreateTaskInput {
  const issueSuffix = args.issueNumber == null ? "" : ` for Issue #${args.issueNumber}`;
  const pullRequestLabel = `PR #${args.pullRequest.number}`;
  const location = args.pullRequest.url ? ` (${args.pullRequest.url})` : "";
  return {
    title: `review: audit ${pullRequestLabel}${issueSuffix}`,
    prompt: [
      "Audit the GitHub pull request below against the parent development task.",
      `Pull request: ${pullRequestLabel}${location}`,
      `Parent development task: ${args.source.id}`,
      "",
      "Review requirements:",
      "1. Inspect the pull request diff and changed tests with GitHub CLI.",
      "2. Verify the implementation satisfies the parent task and does not introduce regressions.",
      "3. Run the relevant repository validation commands when available.",
      "4. Report concrete findings and required changes.",
      "",
      "The final response MUST contain exactly one machine-readable line:",
      "REVIEW_STATUS: approved",
      "or",
      "REVIEW_STATUS: rejected",
      "When rejected, also include one REVIEW_FEEDBACK: line with the concrete fixes required.",
    ].join("\n"),
    model: args.source.model,
    agentId: args.source.agentId,
    category: "review",
    priority: 10,
    parentTaskId: args.source.id,
    inheritContext: false,
    maxRetries: args.source.maxRetries,
    executionIsolation: "default",
    createdBy: "task-review-workflow",
  };
}

export function buildReworkTaskInput(args: {
  reviewTask: Task;
  pullRequest: PullRequestReference;
  feedback: string;
}): CreateTaskInput {
  const feedback = args.feedback.trim() || "Address the reviewer's rejected findings and update the pull request.";
  const location = args.pullRequest.url ? ` (${args.pullRequest.url})` : "";
  return {
    title: `rework: fix issues in PR #${args.pullRequest.number}`,
    prompt: [
      "Fix the rejected GitHub pull request and preserve the original task intent.",
      `Pull request: PR #${args.pullRequest.number}${location}`,
      `Review task: ${args.reviewTask.id}`,
      "",
      "Required review fixes:",
      feedback,
      "",
      "Run relevant tests, update the pull request, and report the resulting PR reference.",
    ].join("\n"),
    model: args.reviewTask.model,
    agentId: args.reviewTask.agentId,
    category: "rework",
    priority: 50,
    parentTaskId: args.reviewTask.id,
    inheritContext: false,
    maxRetries: args.reviewTask.maxRetries,
    executionIsolation: "default",
    createdBy: "task-review-workflow",
  };
}

export function isReviewWorkflowCategory(category: TaskCategory): boolean {
  return category === "development" || category === "rework";
}
