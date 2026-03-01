import { describe, expect, it } from "vitest";

import type { TaskBundleDraft } from "../api/types";

import { listTaskBundleDrafts, removeTaskBundleDraft, upsertTaskBundleDraft } from "./taskBundleDraftsState";

function createDraft(overrides: Partial<TaskBundleDraft> = {}): TaskBundleDraft {
  return {
    id: "draft-1",
    workspaceRoot: "/tmp/ws",
    requestId: "req-1",
    status: "draft",
    bundle: { version: 1, tasks: [{ prompt: "p1" }] },
    createdAt: 1,
    updatedAt: 1,
    approvedAt: null,
    approvedTaskIds: [],
    lastError: null,
    ...overrides,
  };
}

describe("taskBundleDraftsState", () => {
  it("normalizes unknown draft collections to empty array", () => {
    expect(listTaskBundleDrafts(null)).toEqual([]);
    expect(listTaskBundleDrafts({})).toEqual([]);
  });

  it("inserts new draft at the front", () => {
    const existing = [createDraft({ id: "draft-2" })];
    const next = upsertTaskBundleDraft(existing, createDraft({ id: "draft-1" }));
    expect(next.map((draft) => draft.id)).toEqual(["draft-1", "draft-2"]);
  });

  it("replaces existing draft by default", () => {
    const existing = [createDraft({ id: "draft-1", updatedAt: 1 })];
    const next = upsertTaskBundleDraft(existing, createDraft({ id: "draft-1", updatedAt: 5 }));
    expect(next).toHaveLength(1);
    expect(next[0]!.updatedAt).toBe(5);
  });

  it("supports merge mode for partial websocket updates", () => {
    const existing = [createDraft({ id: "draft-1", updatedAt: 1, degradeReason: "legacy" })];
    const next = upsertTaskBundleDraft(existing, createDraft({ id: "draft-1", updatedAt: 10, degradeReason: null }), {
      mergeExisting: true,
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.updatedAt).toBe(10);
    expect(next[0]!.workspaceRoot).toBe("/tmp/ws");
  });

  it("returns same reference when delete id is empty or missing", () => {
    const existing = [createDraft({ id: "draft-1" })];
    expect(removeTaskBundleDraft(existing, "")).toBe(existing);
    expect(removeTaskBundleDraft(existing, "missing")).toBe(existing);
  });

  it("removes matching draft by id", () => {
    const existing = [createDraft({ id: "draft-1" }), createDraft({ id: "draft-2" })];
    const next = removeTaskBundleDraft(existing, "draft-1");
    expect(next.map((draft) => draft.id)).toEqual(["draft-2"]);
  });
});
