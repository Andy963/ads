import { describe, expect, it } from "vitest";

import type { Task } from "../api/types";
import { compareTasksForDisplay, shouldDisplayTask } from "./task_sort";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "t",
    title: overrides.title ?? "task",
    prompt: overrides.prompt ?? "",
    model: overrides.model ?? "codex",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    agentId: overrides.agentId ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    createdAt: overrides.createdAt ?? 0,
    ...overrides,
  };
}

describe("task_sort", () => {
  it("keeps newest queued/pending tasks on top and moves running/planning to the bottom", () => {
    const tasks = [
      makeTask({ id: "pending-old", status: "pending", createdAt: 100 }),
      makeTask({ id: "running-new", status: "running", createdAt: 400 }),
      makeTask({ id: "queued-new", status: "queued", createdAt: 300 }),
      makeTask({ id: "planning-mid", status: "planning", createdAt: 200 }),
    ];

    const sorted = tasks.slice().sort(compareTasksForDisplay).map((task) => task.id);
    expect(sorted).toEqual(["queued-new", "pending-old", "running-new", "planning-mid"]);
  });

  it("sorts same-created tasks by priority as a tie-breaker", () => {
    const tasks = [
      makeTask({ id: "low-priority", status: "pending", priority: 1, createdAt: 100 }),
      makeTask({ id: "high-priority", status: "pending", priority: 2, createdAt: 100 }),
      makeTask({ id: "latest", status: "pending", priority: 0, createdAt: 200 }),
    ];

    const sorted = tasks.slice().sort(compareTasksForDisplay).map((task) => task.id);
    expect(sorted).toEqual(["latest", "high-priority", "low-priority"]);
  });

  it("hides completed tasks from task lists", () => {
    expect(shouldDisplayTask(makeTask({ status: "completed" }))).toBe(false);
    expect(shouldDisplayTask(makeTask({ status: "pending" }))).toBe(true);
  });
});
