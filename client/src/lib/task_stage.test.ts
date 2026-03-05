import { describe, expect, it } from "vitest";

import { deriveTaskStage } from "./task_stage";

describe("task_stage", () => {
  it("classifies all completed tasks as done", () => {
    expect(deriveTaskStage({ status: "completed" })).toBe("done");
  });

  it("keeps failed execution tasks in in_progress", () => {
    expect(deriveTaskStage({ status: "failed" })).toBe("in_progress");
  });

  it("treats queued/pending/cancelled as backlog", () => {
    expect(deriveTaskStage({ status: "queued" })).toBe("backlog");
    expect(deriveTaskStage({ status: "pending" })).toBe("backlog");
    expect(deriveTaskStage({ status: "paused" })).toBe("backlog");
    expect(deriveTaskStage({ status: "cancelled" })).toBe("backlog");
  });

  it("treats planning/running as in_progress", () => {
    expect(deriveTaskStage({ status: "planning" })).toBe("in_progress");
    expect(deriveTaskStage({ status: "running" })).toBe("in_progress");
  });
});
