import { ref } from "vue";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { Task } from "../../api/types";
import type { ProjectRuntime } from "../controllerTypes";
import { createTaskRunHelpers } from "./runHelpers";

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

function createRuntime(tasks: Task[] = []): ProjectRuntime {
  return {
    tasks: ref(tasks),
    runBusyIds: ref(new Set<string>()),
  } as unknown as ProjectRuntime;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("app/tasks/runHelpers", () => {
  it("updates runBusyIds when toggling busy state", () => {
    const runtime = createRuntime();
    const helpers = createTaskRunHelpers({
      activeProjectId: ref("p1"),
      normalizeProjectId: (id) => String(id ?? "").trim() || "default",
      getRuntime: () => runtime,
      upsertTask: () => {},
    });

    helpers.setTaskRunBusy("t-1", true);
    expect(Array.from(runtime.runBusyIds.value)).toEqual(["t-1"]);

    helpers.setTaskRunBusy("t-1", false);
    expect(Array.from(runtime.runBusyIds.value)).toEqual([]);
  });

  it("ignores empty task ids", () => {
    const runtime = createRuntime();
    const helpers = createTaskRunHelpers({
      activeProjectId: ref("p1"),
      normalizeProjectId: (id) => String(id ?? "").trim() || "default",
      getRuntime: () => runtime,
      upsertTask: () => {},
    });

    helpers.setTaskRunBusy("  ", true);
    helpers.mockSingleTaskRun(" ");

    expect(Array.from(runtime.runBusyIds.value)).toEqual([]);
    expect(runtime.tasks.value).toEqual([]);
  });

  it("mockSingleTaskRun transitions task from running to completed", () => {
    vi.useFakeTimers();

    const runtime = createRuntime([makeTask({ id: "t-1", status: "pending" })]);
    const upsertTask = vi.fn((task: Task, rt?: ProjectRuntime) => {
      const target = (rt ?? runtime) as ProjectRuntime;
      const current = Array.isArray(target.tasks.value) ? target.tasks.value : [];
      const index = current.findIndex((item) => item.id === task.id);
      if (index < 0) {
        target.tasks.value = [...current, task];
        return;
      }
      target.tasks.value = [...current.slice(0, index), task, ...current.slice(index + 1)];
    });

    const helpers = createTaskRunHelpers({
      activeProjectId: ref("p1"),
      normalizeProjectId: (id) => String(id ?? "").trim() || "default",
      getRuntime: () => runtime,
      upsertTask,
    });

    helpers.mockSingleTaskRun("t-1");
    expect(runtime.tasks.value.find((task) => task.id === "t-1")?.status).toBe("running");

    vi.advanceTimersByTime(900);
    expect(runtime.tasks.value.find((task) => task.id === "t-1")?.status).toBe("completed");
    expect(runtime.tasks.value.find((task) => task.id === "t-1")?.result).toBe("mock: completed");
    expect(upsertTask).toHaveBeenCalled();
  });
});
