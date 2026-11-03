import type { ReviewDefect } from "../reviewer/types.js";

export const REVIEW_COMMENT_MARKER = "<!-- ads:review-verdict -->";

export type IssueVerdictStatus = "PASS" | "REJECT" | "INCOMPLETE" | "ERROR";

export interface IssueVerdictCommentInput {
  jobId: string;
  prNumber?: number | null;
  headSha?: string | null;
  baseSha?: string | null;
  status: IssueVerdictStatus;
  summary: string;
  defects?: ReviewDefect[];
  publishedAt?: number;
}

export interface ParsedIssueVerdictComment {
  status: IssueVerdictStatus;
  jobId: string;
  prNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  summary: string;
}

const NEXT_STEP: Record<IssueVerdictStatus, string> = {
  PASS: "Next step: request delivery authorization; a PASS is not merge approval.",
  REJECT: "Next step: fix the findings, push the new commit, then run review_action again.",
  INCOMPLETE: "Next step: restore the reported precondition, then run review_action again. No code was rejected.",
  ERROR: "Next step: inspect the Actions lane for the operational error, fix the environment, then run review_action again.",
};

function shortSha(value: string | null | undefined): string {
  const sha = String(value ?? "").trim();
  return sha ? `\`${sha.slice(0, 12)}\`` : "_unknown_";
}

function formatFinding(defect: ReviewDefect): string {
  const location = defect.line !== undefined ? `${defect.file}:${defect.line}` : defect.file;
  return `- \`${location}\` (${defect.severity}): ${defect.description}`;
}

export function buildIssueVerdictComment(input: IssueVerdictCommentInput): string {
  const publishedAt = new Date(input.publishedAt ?? Date.now()).toISOString();
  const lines = [
    REVIEW_COMMENT_MARKER,
    `## ADS Reviewer verdict: ${input.status}`,
    "",
    `- PR: ${input.prNumber ? `#${input.prNumber}` : "_none_"}`,
    `- Head: ${shortSha(input.headSha)}`,
    `- Base: ${shortSha(input.baseSha)}`,
    `- Job: \`${input.jobId}\``,
    `- Time: ${publishedAt}`,
    "",
    `**Summary**: ${input.summary.trim() || "_No summary reported._"}`,
  ];
  const defects = input.defects ?? [];
  if (input.status === "REJECT" && defects.length > 0) {
    lines.push("", "**Findings**:", ...defects.map(formatFinding));
  }
  lines.push("", NEXT_STEP[input.status]);
  return lines.join("\n");
}

export function parseIssueVerdictComment(body: string): ParsedIssueVerdictComment | null {
  const text = String(body ?? "");
  if (!text.includes(REVIEW_COMMENT_MARKER)) return null;
  const statusMatch = /^## ADS Reviewer verdict: (PASS|REJECT|INCOMPLETE|ERROR)$/m.exec(text);
  const jobMatch = /^- Job: `([^`]+)`$/m.exec(text);
  if (!statusMatch || !jobMatch) return null;
  const prMatch = /^- PR: #(\d+)$/m.exec(text);
  const headMatch = /^- Head: `([^`]+)`$/m.exec(text);
  const baseMatch = /^- Base: `([^`]+)`$/m.exec(text);
  const summaryMatch = /^\*\*Summary\*\*: (.*)$/m.exec(text);
  return {
    status: statusMatch[1] as IssueVerdictStatus,
    jobId: jobMatch[1]!,
    prNumber: prMatch ? Number(prMatch[1]) : null,
    headSha: headMatch ? headMatch[1]! : null,
    baseSha: baseMatch ? baseMatch[1]! : null,
    summary: summaryMatch ? summaryMatch[1]!.trim() : "",
  };
}
