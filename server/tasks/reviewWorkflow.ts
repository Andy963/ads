import type { CreateTaskInput, ReviewerModelSelection, Task, TaskCategory } from "./types.js";
import { defaultTaskReviewSummary } from "./reviewData.js";

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

export function findRootTaskInChain(
  task: Task,
  getTask: (id: string) => Task | null,
  maxDepth = 32,
): Task {
  let current = task;
  const seen = new Set<string>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parentId = String(current.parentTaskId ?? "").trim();
    if (!parentId || seen.has(parentId)) return current;
    seen.add(current.id);
    const parent = getTask(parentId);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

export function findWorkerTaskInChain(
  task: Task,
  getTask: (id: string) => Task | null,
): Task {
  const root = findRootTaskInChain(task, getTask);
  if (root.category === "development") return root;
  let current: Task | null = task;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.category === "development" || current.category === "rework") return current;
    current = current.parentTaskId ? getTask(current.parentTaskId) : null;
  }
  return root;
}

export function reviewSubjectForTask(task: Task, getTask: (id: string) => Task | null): Task | null {
  if (task.category === "review") {
    return task.parentTaskId ? getTask(task.parentTaskId) : null;
  }
  return task.category === "development" || task.category === "rework" ? task : null;
}

export function reviewConclusion(result: string): string {
  return String(result ?? "")
    .replace(/^\s*REVIEW_STATUS\s*:\s*(?:approved|rejected)\s*$/gim, "")
    .replace(/^\s*REVIEW_FEEDBACK\s*:\s*.*$/gim, "")
    .trim()
    .slice(0, 4000) || "Reviewer returned a machine-readable verdict.";
}

export function mergeReviewSummary(task: Task, patch: Partial<NonNullable<Task["review"]>>): NonNullable<Task["review"]> {
  return defaultTaskReviewSummary({ ...(task.review ?? {}), ...patch });
}

export function buildReviewTaskInput(args: {
  source: Task;
  pullRequest: PullRequestReference;
  issueNumber?: number | null;
  reviewerModel: ReviewerModelSelection;
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
    model: args.reviewerModel.model,
    agentId: args.reviewerModel.agentId,
    category: "review",
    priority: 10,
    parentTaskId: args.source.id,
    inheritContext: false,
    maxRetries: args.source.maxRetries,
    executionIsolation: "default",
    createdBy: "task-review-workflow",
    review: defaultTaskReviewSummary({
      required: true,
      rootTaskId: args.source.review?.rootTaskId ?? args.source.id,
      pullRequestNumber: args.pullRequest.number,
      pullRequestUrl: args.pullRequest.url,
      reviewTaskId: undefined,
      reviewerModelConfigId: args.reviewerModel.modelConfigId ?? null,
      reviewerModelId: args.reviewerModel.modelId ?? args.reviewerModel.model,
      reviewerModelDisplayName: args.reviewerModel.displayName ?? args.reviewerModel.model,
      reviewerAgentId: args.reviewerModel.agentId,
      maxReworkRounds: args.source.review?.maxReworkRounds ?? 2,
    }),
  };
}

export function buildReworkTaskInput(args: {
  reviewTask: Task;
  pullRequest: PullRequestReference;
  feedback: string;
  workerTask?: Task | null;
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
    model: args.workerTask?.model ?? args.reviewTask.model,
    agentId: args.workerTask?.agentId ?? args.reviewTask.agentId,
    category: "rework",
    priority: 50,
    parentTaskId: args.reviewTask.id,
    inheritContext: false,
    maxRetries: args.reviewTask.maxRetries,
    executionIsolation: "default",
    createdBy: "task-review-workflow",
    review: defaultTaskReviewSummary({
      required: true,
      rootTaskId: args.reviewTask.review?.rootTaskId ?? args.workerTask?.review?.rootTaskId ?? args.reviewTask.parentTaskId,
      pullRequestNumber: args.pullRequest.number,
      pullRequestUrl: args.pullRequest.url,
      maxReworkRounds: args.reviewTask.review?.maxReworkRounds ?? 2,
      reworkRound: (args.reviewTask.review?.reworkRound ?? 0) + 1,
      automationMode: args.reviewTask.review?.automationMode,
    }),
  };
}

export function isReviewWorkflowCategory(category: TaskCategory): boolean {
  return category === "development" || category === "rework";
}
