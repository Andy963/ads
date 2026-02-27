import { describe, expect, it } from "vitest";

import type { Task } from "../api/types";
import { compareTasksForDisplay } from "./task_sort";

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
  it("sorts tasks by status weight and status name", () => {
    const tasks = [
      makeTask({ id: "completed", status: "completed" }),
      makeTask({ id: "failed", status: "failed" }),
      makeTask({ id: "queued", status: "queued" }),
      makeTask({ id: "running", status: "running" }),
      makeTask({ id: "pending", status: "pending" }),
      makeTask({ id: "planning", status: "planning" }),
    ];

    const sorted = tasks.slice().sort(compareTasksForDisplay).map((task) => task.id);
    expect(sorted).toEqual(["running", "planning", "pending", "queued", "failed", "completed"]);
  });

  it("sorts same-status tasks by priority then createdAt", () => {
    const tasks = [
      makeTask({ id: "low-priority", status: "pending", priority: 1, createdAt: 100 }),
      makeTask({ id: "newer", status: "pending", priority: 2, createdAt: 200 }),
      makeTask({ id: "older", status: "pending", priority: 2, createdAt: 100 }),
    ];

    const sorted = tasks.slice().sort(compareTasksForDisplay).map((task) => task.id);
    expect(sorted).toEqual(["newer", "older", "low-priority"]);
  });
});
