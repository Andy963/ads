import { safeParseJson } from "../utils/json.js";

import type { TaskContext } from "./types.js";

export function truncate(text: string, limit = 4000): string {
  const normalized = String(text ?? "");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

type WorkspacePatchFileStat = { path: string; added: number | null; removed: number | null };
type WorkspacePatchPayload = { files: WorkspacePatchFileStat[]; diff: string; truncated: boolean };
type TaskWorkspacePatchArtifact = { paths: string[]; patch: WorkspacePatchPayload | null; reason?: string; createdAt: number };
export function getLatestContextOfType(contexts: TaskContext[], contextType: string): TaskContext | null {
  const type = String(contextType ?? "").trim();
  if (!type) return null;
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const context = contexts[i];
    if (context && context.contextType === type) return context;
  }
  return null;
}

export function formatWorkspacePatchArtifactForPrompt(context: TaskContext | null): string {
  if (!context) return "";
  const parsed = safeParseJson<TaskWorkspacePatchArtifact>(context.content);
  if (!parsed) return "";
  const paths = Array.isArray(parsed.paths) ? parsed.paths.map((p) => String(p ?? "").trim()).filter(Boolean) : [];
  const patch = parsed.patch ?? null;
  const reason = parsed.reason ? String(parsed.reason) : "";

  const lines: string[] = [];
  lines.push("Previous attempt workspace changes:");
  if (paths.length > 0) {
    lines.push(`- Changed files (${paths.length}): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? " ..." : ""}`);
  } else {
    lines.push("- Changed files: (unknown)");
  }
  if (!patch || !patch.diff.trim()) {
    lines.push(`- Patch: (unavailable)${reason ? ` reason=${reason}` : ""}`);
    return lines.join("\n");
  }
  lines.push(`- Patch truncated: ${patch.truncated ? "yes" : "no"}`);
  lines.push("");
  lines.push("```diff");
  lines.push(String(patch.diff ?? "").trimEnd());
  lines.push("```");
  return lines.join("\n");
}
