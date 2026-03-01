import { createLogger, type Logger } from "../../utils/logger.js";

import type { ReviewResponse, ReviewVerdict } from "./schemas.js";
import { parseReviewVerdict } from "./schemas.js";
import type { BootstrapReviewerRunner } from "./reviewerRunner.js";

export type ReviewGateInput = {
  goal: string;
  changedFiles: string[];
  diffPatch: string;
  diffPatchTruncated: boolean;
  lintSummary: string;
  testSummary: string;
  previousVerdict: ReviewVerdict | null;
  previousResponse: ReviewResponse | null;
  previousResponseRaw: string;
  round: number;
  maxRounds: number;
};

export type ReviewGateOutput = {
  approve: boolean;
  verdict: ReviewVerdict;
  rawResponse: string;
  attempts: number;
};

function formatTruncatedFlag(truncated: boolean): string {
  return truncated ? "yes" : "no";
}

function buildReviewPrompt(skillText: string, input: ReviewGateInput): string {
  const parts: string[] = [];
  const skill = String(skillText ?? "").trim();
  if (skill) {
    parts.push(skill);
    parts.push("");
  }

  parts.push("Context:");
  parts.push(`- Review round: ${input.round}/${input.maxRounds}`);
  parts.push(`- Lint summary: ${input.lintSummary.trim() || "(empty)"}`);
  parts.push(`- Test summary: ${input.testSummary.trim() || "(empty)"}`);
  parts.push(`- Diff truncated: ${formatTruncatedFlag(input.diffPatchTruncated)}`);
  parts.push("");

  parts.push("Goal:");
  parts.push(String(input.goal ?? "").trim() || "(empty)");
  parts.push("");

  parts.push("Changed files:");
  if (input.changedFiles.length === 0) {
    parts.push("- (none)");
  } else {
    for (const file of input.changedFiles.slice(0, 200)) {
      parts.push(`- ${file}`);
    }
    if (input.changedFiles.length > 200) {
      parts.push(`- ... (${input.changedFiles.length - 200} more)`);
    }
  }
  parts.push("");

  if (input.previousVerdict) {
    parts.push("Previous ReviewVerdict (most recent):");
    parts.push("```json");
    parts.push(JSON.stringify(input.previousVerdict, null, 2));
    parts.push("```");
    parts.push("");
  }

  if (input.previousResponse) {
    parts.push("Executor ReviewResponse (most recent):");
    parts.push("```json");
    parts.push(JSON.stringify(input.previousResponse, null, 2));
    parts.push("```");
    parts.push("");
  } else if (input.previousResponseRaw.trim()) {
    parts.push("Executor response (raw, not structured JSON):");
    parts.push("```text");
    parts.push(input.previousResponseRaw.trim().slice(0, 16_000));
    parts.push("```");
    parts.push("");
  }

  parts.push("Diff:");
  parts.push("```diff");
  parts.push(String(input.diffPatch ?? "").trimEnd().slice(0, 200_000));
  parts.push("```");
  parts.push("");

  parts.push("Output:");
  parts.push("Return a single JSON object matching ReviewVerdict. Do not wrap it in markdown.");

  return parts.join("\n").trim() + "\n";
}

function buildRetryPrompt(skillText: string, input: ReviewGateInput, reason: string): string {
  const parts: string[] = [];
  parts.push(buildReviewPrompt(skillText, input));
  parts.push("");
  parts.push("The previous output was invalid and could not be parsed as ReviewVerdict JSON.");
  parts.push(`Reason: ${reason}`);
  parts.push("");
  parts.push("Retry: output ONLY valid JSON matching ReviewVerdict. No markdown fences, no commentary.");
  return parts.join("\n").trim() + "\n";
}

export class ReviewGate {
  private readonly logger: Logger;
  private readonly runner: BootstrapReviewerRunner;
  private readonly skillText: string;

  constructor(options: { runner: BootstrapReviewerRunner; skillText: string; logger?: Logger }) {
    this.logger = options.logger ?? createLogger("ReviewGate");
    this.runner = options.runner;
    this.skillText = options.skillText;
  }

  async run(input: ReviewGateInput, options?: { cwd: string; signal?: AbortSignal }): Promise<ReviewGateOutput> {
    const prompt = buildReviewPrompt(this.skillText, input);
    const first = await this.runner.runReview({ prompt, cwd: options?.cwd ?? process.cwd(), signal: options?.signal });
    const parsed = parseReviewVerdict(first.response);
    if (parsed.ok) {
      return { approve: parsed.verdict.approve, verdict: parsed.verdict, rawResponse: first.response, attempts: 1 };
    }

    this.logger.warn(`[ReviewGate] invalid verdict JSON; retrying once (reason=${parsed.error})`);
    const retryPrompt = buildRetryPrompt(this.skillText, input, parsed.error);
    const second = await this.runner.runReview({ prompt: retryPrompt, cwd: options?.cwd ?? process.cwd(), signal: options?.signal });
    const parsedRetry = parseReviewVerdict(second.response);
    if (parsedRetry.ok) {
      return { approve: parsedRetry.verdict.approve, verdict: parsedRetry.verdict, rawResponse: second.response, attempts: 2 };
    }

    throw new Error(`reviewer returned invalid JSON twice: ${parsed.error} / ${parsedRetry.error}`);
  }
}

