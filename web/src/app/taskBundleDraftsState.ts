import type { TaskBundleDraft } from "../api/types";

export function listTaskBundleDrafts(value: unknown): TaskBundleDraft[] {
  return Array.isArray(value) ? (value as TaskBundleDraft[]) : [];
}

export function upsertTaskBundleDraft(
  drafts: readonly TaskBundleDraft[],
  draft: TaskBundleDraft,
  options?: { mergeExisting?: boolean },
): TaskBundleDraft[] {
  const id = String(draft?.id ?? "").trim();
  if (!id) {
    return drafts as TaskBundleDraft[];
  }

  const idx = drafts.findIndex((entry) => String(entry.id) === id);
  if (idx < 0) {
    return [draft, ...drafts];
  }

  const next = drafts.slice();
  next[idx] = options?.mergeExisting ? ({ ...next[idx], ...draft } as TaskBundleDraft) : draft;
  return next;
}

export function removeTaskBundleDraft(drafts: readonly TaskBundleDraft[], draftId: string): TaskBundleDraft[] {
  const id = String(draftId ?? "").trim();
  if (!id) {
    return drafts as TaskBundleDraft[];
  }

  const idx = drafts.findIndex((entry) => String(entry.id) === id);
  if (idx < 0) {
    return drafts as TaskBundleDraft[];
  }

  return [...drafts.slice(0, idx), ...drafts.slice(idx + 1)];
}
