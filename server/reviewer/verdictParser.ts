import { z } from "zod";
import type { ReviewVerdict, ReviewDefect } from "./types.js";

const defectSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  severity: z.enum(["blocker", "warning"]).default("warning"),
  description: z.string(),
});

const verdictSchema = z.object({
  status: z.enum(["PASS", "REJECT"]),
  summary: z.string(),
  defects: z.array(defectSchema).default([]),
});

export class ReviewerProtocolError extends Error {
  readonly code = "REVIEWER_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ReviewerProtocolError";
  }
}

export function parseReviewVerdict(rawText: string, reviewerProfileId?: string): ReviewVerdict {
  let cleaned = rawText.trim();

  // Strip markdown code fences if present
  const jsonMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleaned);
  if (jsonMatch && jsonMatch[1]) {
    cleaned = jsonMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Parser diagnostics can contain model output; expose only a fixed reason.
    throw new ReviewerProtocolError("Reviewer returned invalid verdict JSON.");
  }
  const validated = verdictSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ReviewerProtocolError("Reviewer verdict JSON does not match the required PASS/REJECT schema.");
  }
  return {
    status: validated.data.status,
    summary: validated.data.summary,
    defects: validated.data.defects as ReviewDefect[],
    reviewerProfileId,
    reviewedAt: Date.now(),
  };
}
