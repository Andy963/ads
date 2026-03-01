import { describe, expect, it } from "vitest";

import { isProjectInProgress } from "../lib/project_status";

describe("project in-progress aggregation", () => {
  it("treats conversationInProgress as in progress even when no task is running", () => {
    expect(
      isProjectInProgress({
        taskStatuses: ["pending", "completed"],
        conversationInProgress: true,
      }),
    ).toBe(true);
  });

  it("treats planning/running task as in progress even when conversationInProgress is false", () => {
    expect(
      isProjectInProgress({
        taskStatuses: ["pending", "planning"],
        conversationInProgress: false,
      }),
    ).toBe(true);

    expect(
      isProjectInProgress({
        taskStatuses: ["running"],
        conversationInProgress: false,
      }),
    ).toBe(true);
  });

  it("is not in progress when there is no in-flight conversation and no running/planning task", () => {
    expect(
      isProjectInProgress({
        taskStatuses: ["queued", "pending", "paused", "completed", "failed", "cancelled"],
        conversationInProgress: false,
      }),
    ).toBe(false);
  });

  it("handles multiple tasks: any running/planning makes the project in progress", () => {
    expect(
      isProjectInProgress({
        taskStatuses: ["completed", "failed", "running", "pending"],
        conversationInProgress: false,
      }),
    ).toBe(true);
  });
});
