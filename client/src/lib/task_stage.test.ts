import { describe, expect, it } from "vitest";

import { deriveTaskStage } from "./task_stage";

describe("task_stage", () => {
  it("classifies completed tasks into in_review/done based on review fields", () => {
    expect(deriveTaskStage({ status: "completed", reviewRequired: false, reviewStatus: "none" })).toBe("done");
    expect(deriveTaskStage({ status: "completed", reviewRequired: true, reviewStatus: "none" })).toBe("in_review");
    expect(deriveTaskStage({ status: "completed", reviewRequired: true, reviewStatus: "pending" })).toBe("in_review");
    expect(deriveTaskStage({ status: "completed", reviewRequired: true, reviewStatus: "running" })).toBe("in_review");
    expect(deriveTaskStage({ status: "completed", reviewRequired: true, reviewStatus: "rejected" })).toBe("in_review");
    expect(deriveTaskStage({ status: "completed", reviewRequired: true, reviewStatus: "passed" })).toBe("done");
  });

  it("keeps failed execution tasks in in_progress", () => {
    expect(deriveTaskStage({ status: "failed", reviewRequired: false, reviewStatus: "none" })).toBe("in_progress");
  });

  it("treats queued/pending/cancelled as backlog", () => {
    expect(deriveTaskStage({ status: "queued", reviewRequired: false, reviewStatus: "none" })).toBe("backlog");
    expect(deriveTaskStage({ status: "pending", reviewRequired: false, reviewStatus: "none" })).toBe("backlog");
    expect(deriveTaskStage({ status: "paused", reviewRequired: false, reviewStatus: "none" })).toBe("backlog");
    expect(deriveTaskStage({ status: "cancelled", reviewRequired: false, reviewStatus: "none" })).toBe("backlog");
  });

  it("treats planning/running as in_progress", () => {
    expect(deriveTaskStage({ status: "planning", reviewRequired: false, reviewStatus: "none" })).toBe("in_progress");
    expect(deriveTaskStage({ status: "running", reviewRequired: false, reviewStatus: "none" })).toBe("in_progress");
  });
});

