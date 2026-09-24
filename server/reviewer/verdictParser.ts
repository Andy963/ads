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

export function parseReviewVerdict(rawText: string, reviewerProfileId?: string): ReviewVerdict {
  let cleaned = rawText.trim();

  // Strip markdown code fences if present
  const jsonMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleaned);
  if (jsonMatch && jsonMatch[1]) {
    cleaned = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    const validated = verdictSchema.parse(parsed);
    return {
      status: validated.status,
      summary: validated.summary,
      defects: validated.defects as ReviewDefect[],
      reviewerProfileId,
      reviewedAt: Date.now(),
    };
  } catch {
    return {
      status: "REJECT",
      summary: "Failed to parse structured review verdict.",
      defects: [
        {
          file: "unknown",
          severity: "blocker",
          description: "Reviewer output did not match the required structured verdict JSON.",
        },
      ],
      reviewerProfileId,
      reviewedAt: Date.now(),
    };
  }
}
