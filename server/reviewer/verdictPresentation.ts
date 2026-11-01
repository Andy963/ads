import type { ReviewVerdict } from "./types.js";
import { parseReviewVerdict } from "./verdictParser.js";

/**
 * Parse a standalone Reviewer verdict document. Returns null for any text that
 * is not exactly the PASS/REJECT protocol so callers can keep normal prose
 * untouched.
 */
export function parseReviewVerdictText(text: string): ReviewVerdict | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("```")) return null;
  try {
    return parseReviewVerdict(trimmed);
  } catch {
    return null;
  }
}

/** Summary text plus one line per finding, without the verdict status line. */
export function formatReviewVerdictDetails(verdict: ReviewVerdict): string {
  const lines: string[] = [];
  const summary = String(verdict.summary ?? "").trim();
  if (summary) lines.push(summary);
  if (verdict.defects.length === 0) {
    lines.push("No findings reported.");
    return lines.join("\n");
  }
  lines.push("Findings:");
  for (const defect of verdict.defects) {
    const location = defect.line !== undefined ? `${defect.file}:${defect.line}` : defect.file;
    lines.push(`- ${location} (${defect.severity}): ${defect.description}`);
  }
  return lines.join("\n");
}

/** Human-readable verdict for lane output. Never contains protocol JSON. */
export function formatReviewVerdictText(verdict: ReviewVerdict): string {
  return [`Reviewer verdict: ${verdict.status}`, formatReviewVerdictDetails(verdict)].join("\n");
}

/**
 * Replace a protocol verdict with its readable form. Any other text passes
 * through unchanged so ordinary lane answers keep their original wording.
 */
export function presentReviewVerdictText(text: string): string {
  const verdict = parseReviewVerdictText(text);
  return verdict ? formatReviewVerdictText(verdict) : text;
}
