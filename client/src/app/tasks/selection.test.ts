import { describe, expect, it } from "vitest";

import type { Task } from "../../api/types";
import { pickNextSelectedTaskId } from "./selection";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    prompt: overrides.prompt ?? "Prompt",
    model: overrides.model ?? "auto",
    modelParams: overrides.modelParams ?? null,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    queuedAt: overrides.queuedAt ?? null,
    promptInjectedAt: overrides.promptInjectedAt ?? null,
    inheritContext: overrides.inheritContext ?? false,
    agentId: overrides.agentId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    threadId: overrides.threadId ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    createdAt: overrides.createdAt ?? 0,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("app/tasks/selection", () => {
  it("returns null for empty task list", () => {
    expect(pickNextSelectedTaskId([])).toBeNull();
  });

  it("selects pending task by priority, queue order, and createdAt", () => {
    const tasks: Task[] = [
      makeTask({ id: "done", status: "completed", priority: 10, queueOrder: 1, createdAt: 10 }),
      makeTask({ id: "low-priority", status: "pending", priority: 1, queueOrder: 1, createdAt: 10 }),
      makeTask({ id: "best", status: "pending", priority: 2, queueOrder: 2, createdAt: 20 }),
      makeTask({ id: "same-priority-later", status: "pending", priority: 2, queueOrder: 5, createdAt: 0 }),
      makeTask({ id: "same-priority-earlier-created", status: "pending", priority: 2, queueOrder: 5, createdAt: -1 }),
    ];
    expect(pickNextSelectedTaskId(tasks)).toBe("best");
  });

  it("falls back to first task when there is no pending task", () => {
    const tasks: Task[] = [
      makeTask({ id: "completed", status: "completed" }),
      makeTask({ id: "failed", status: "failed" }),
    ];
    expect(pickNextSelectedTaskId(tasks)).toBe("completed");
  });
});
