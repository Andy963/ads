import { z } from "zod";

import { extractJsonPayload } from "../../agents/tasks/schemas.js";

export const ReviewRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type ReviewRiskLevel = z.infer<typeof ReviewRiskLevelSchema>;

export const ReviewIssueSchema = z.object({
  title: z.string().min(1),
  file: z.string().min(1),
  rationale: z.string().min(1),
  suggestedFix: z.string().min(1),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewSuggestionSchema = z.object({
  title: z.string().min(1),
  file: z.string().min(1),
  rationale: z.string().min(1),
});

export type ReviewSuggestion = z.infer<typeof ReviewSuggestionSchema>;

export const ReviewVerdictSchema = z.object({
  approve: z.boolean(),
  riskLevel: ReviewRiskLevelSchema,
  blockingIssues: z.array(ReviewIssueSchema),
  nonBlockingSuggestions: z.array(ReviewSuggestionSchema),
  followUpVerification: z.array(z.string()),
  questions: z.array(z.string()),
}).passthrough();

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewResponseItemStatusSchema = z.enum(["fixed", "not_fixed", "wontfix", "needs_info"]);
export type ReviewResponseItemStatus = z.infer<typeof ReviewResponseItemStatusSchema>;

export const ReviewResponseItemSchema = z.object({
  title: z.string().min(1),
  status: ReviewResponseItemStatusSchema,
  details: z.string().min(1),
});

export type ReviewResponseItem = z.infer<typeof ReviewResponseItemSchema>;

export const ReviewQuestionAnswerSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

export type ReviewQuestionAnswer = z.infer<typeof ReviewQuestionAnswerSchema>;

export const ReviewResponseSchema = z.object({
  responses: z.array(ReviewResponseItemSchema),
  questionsAnswered: z.array(ReviewQuestionAnswerSchema),
}).passthrough();

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export function parseReviewVerdict(rawResponse: string): { ok: true; verdict: ReviewVerdict } | { ok: false; error: string } {
  const payload = extractJsonPayload(rawResponse) ?? rawResponse;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const verdict = ReviewVerdictSchema.parse(parsed);
    return { ok: true, verdict };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

export function parseReviewResponse(rawResponse: string): { ok: true; response: ReviewResponse } | { ok: false; error: string } {
  const payload = extractJsonPayload(rawResponse) ?? rawResponse;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const response = ReviewResponseSchema.parse(parsed);
    return { ok: true, response };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

