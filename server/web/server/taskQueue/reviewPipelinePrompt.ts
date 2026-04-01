import { z } from "zod";

import { extractJsonPayload } from "../../../agents/tasks/schemas.js";
import type { WorkspacePatchPayload } from "../../gitPatch.js";

const WebReviewVerdictSchema = z
  .object({
    verdict: z.enum(["passed", "rejected"]),
    conclusion: z.string().min(1),
  })
  .passthrough();

export type WebReviewVerdict = z.infer<typeof WebReviewVerdictSchema>;

export function parseWebReviewVerdict(
  rawResponse: string,
): { ok: true; verdict: WebReviewVerdict } | { ok: false; error: string } {
  const payload = extractJsonPayload(rawResponse) ?? rawResponse;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const verdict = WebReviewVerdictSchema.parse(parsed);
    return { ok: true, verdict };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export function buildReviewerPrompt(
  task: { id: string; title: string; prompt: string },
  snapshot: { patch: WorkspacePatchPayload | null; changedFiles: string[] },
): string {
  const changedFiles = Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles : [];
  const patchDiff = snapshot.patch?.diff ? String(snapshot.patch.diff) : "";
  const patchTruncated = Boolean(snapshot.patch?.truncated);
  const parts: string[] = [];
  parts.push("You are a strict code reviewer.");
  parts.push(
    "You MUST base your review only on the immutable snapshot below (changed files list + diff patch + summaries).",
  );
  parts.push("Do NOT run any tools. Do NOT assume current repository state. Do NOT ask questions.");
  parts.push("");
  parts.push("Task:");
  parts.push(`- taskId: ${task.id}`);
  parts.push(`- title: ${String(task.title ?? "").trim() || "(empty)"}`);
  parts.push("");
  parts.push("Goal (original prompt):");
  parts.push(String(task.prompt ?? "").trim() || "(empty)");
  parts.push("");
  parts.push("Snapshot:");
  parts.push(`- Diff truncated: ${patchTruncated ? "yes" : "no"}`);
  parts.push("");
  parts.push("Changed files:");
  if (changedFiles.length === 0) {
    parts.push("- (none)");
  } else {
    for (const file of changedFiles.slice(0, 200)) {
      parts.push(`- ${file}`);
    }
    if (changedFiles.length > 200) {
      parts.push(`- ... (${changedFiles.length - 200} more)`);
    }
  }
  parts.push("");
  parts.push("Diff:");
  parts.push("```diff");
  parts.push(patchDiff.trimEnd().slice(0, 200_000));
  parts.push("```");
  parts.push("");
  parts.push("Output:");
  parts.push('Return ONLY a single JSON object: {"verdict":"passed|rejected","conclusion":"..."}');
  parts.push("Do not wrap in markdown. No extra keys are required.");
  return `${parts.join("\n").trim()}\n`;
}
