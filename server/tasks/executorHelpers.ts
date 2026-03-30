import type { BootstrapProjectRef } from "../bootstrap/types.js";
import { safeParseJson } from "../utils/json.js";

import type { TaskStore } from "./store.js";
import type { Task, TaskContext } from "./types.js";

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
type TaskWorktreeReferenceContext = { worktreeDir: string; source?: string; createdAt: number };
type ReviewArtifactReferenceContext = {
  reviewArtifactId?: string;
  snapshotId?: string;
  taskId?: string;
  verdict?: string | null;
  scope?: string | null;
  summaryText?: string;
  responseText?: string;
  createdAt?: number;
};

export type BootstrapModelParams = {
  bootstrap?: {
    enabled?: boolean;
    projectRef?: string;
    maxIterations?: number;
  };
};

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

export function formatReviewArtifactReferenceForPrompt(context: TaskContext | null): string {
  if (!context) return "";
  const parsed = safeParseJson<ReviewArtifactReferenceContext>(context.content);
  if (!parsed) return "";
  const reviewArtifactId = String(parsed.reviewArtifactId ?? "").trim();
  const snapshotId = String(parsed.snapshotId ?? "").trim();
  const taskId = String(parsed.taskId ?? "").trim();
  if (!reviewArtifactId || !snapshotId) return "";

  const lines: string[] = [];
  lines.push("Explicit reviewer guidance artifact:");
  lines.push(`- reviewArtifactId: ${reviewArtifactId}`);
  lines.push(`- snapshotId: ${snapshotId}`);
  if (taskId) {
    lines.push(`- sourceTaskId: ${taskId}`);
  }
  const verdict = String(parsed.verdict ?? "").trim();
  if (verdict) {
    lines.push(`- verdict: ${verdict}`);
  }
  const scope = String(parsed.scope ?? "").trim();
  if (scope) {
    lines.push(`- scope: ${scope}`);
  }
  const summaryText = String(parsed.summaryText ?? "").trim();
  if (summaryText) {
    lines.push("- summary:");
    lines.push(summaryText);
  }
  const responseText = String(parsed.responseText ?? "").trim();
  if (responseText) {
    lines.push("");
    lines.push("Reviewer response:");
    lines.push(responseText);
  }
  return lines.join("\n");
}

export function persistTaskWorktreeReference(
  store: Pick<TaskStore, "saveContext">,
  taskId: string,
  input: { worktreeDir?: string | null; source?: string | null },
  now = Date.now(),
): void {
  const id = String(taskId ?? "").trim();
  const worktreeDir = String(input.worktreeDir ?? "").trim();
  if (!id || !worktreeDir) {
    return;
  }
  const payload: TaskWorktreeReferenceContext = {
    worktreeDir,
    source: String(input.source ?? "").trim() || undefined,
    createdAt: now,
  };
  store.saveContext(
    id,
    { contextType: "artifact:worktree_reference", content: JSON.stringify(payload), createdAt: now },
    now,
  );
}

export function extractBootstrapConfig(task: Task): BootstrapModelParams["bootstrap"] | null {
  const params = task.modelParams as BootstrapModelParams | null | undefined;
  if (!params?.bootstrap?.enabled) return null;
  const ref = String(params.bootstrap.projectRef ?? "").trim();
  if (!ref) return null;
  return params.bootstrap;
}

export function looksLikeGitUrl(value: string): boolean {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  if (trimmed.startsWith("git@") || trimmed.startsWith("ssh://")) return true;
  return false;
}

export function resolveBootstrapProjectRef(ref: string): BootstrapProjectRef {
  return looksLikeGitUrl(ref)
    ? { kind: "git_url", value: ref }
    : { kind: "local_path", value: ref };
}
