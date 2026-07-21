import { describe, expect, it, vi } from "vitest";

import type { Task } from "../api/types";
import { createTaskEventActions } from "../app/tasks/events";

type Ref<T> = { value: T };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "Task",
    prompt: "Do it",
    status: "failed",
    priority: 0,
    maxRetries: 0,
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Task;
}

function createHarness() {
  const rt = {
    tasks: { value: [] } satisfies Ref<Task[]>,
    messages: { value: [] } satisfies Ref<any[]>,
    laneStatus: { value: null } satisfies Ref<any>,
    startedTaskIds: new Set<string>(),
  };
  const pushMessageBeforeLive = vi.fn((message: any) => {
    rt.messages.value.push(message);
  });
  const upsertTask = vi.fn((task: Task) => {
    const idx = rt.tasks.value.findIndex((entry) => entry.id === task.id);
    if (idx >= 0) {
      rt.tasks.value[idx] = task;
    } else {
      rt.tasks.value.push(task);
    }
  });

  const actions = createTaskEventActions(
    {
      randomId: (prefix: string) => `${prefix}-1`,
      runtimeOrActive: () => rt,
      pruneTaskChatBuffer: vi.fn(),
      markTaskChatStarted: vi.fn((taskId: string) => rt.startedTaskIds.add(taskId)),
      ingestCommand: vi.fn(),
      upsertExecuteBlock: vi.fn(),
      upsertStepLiveDelta: vi.fn(),
      upsertStreamingDelta: vi.fn(),
      finalizeAssistant: vi.fn(),
      hasAssistantAfterLastUser: () => false,
      hasEmptyAssistantPlaceholder: () => false,
      pushMessageBeforeLive,
      flushQueuedPrompts: vi.fn(),
      finalizeCommandBlock: vi.fn(),
      clearStepLive: vi.fn(),
      bufferTaskChatEvent: vi.fn(),
    } as any,
    {
      upsertTask,
      removeTask: vi.fn(),
      loadQueueStatus: vi.fn(async () => {}),
    },
  );

  return { actions, rt, pushMessageBeforeLive };
}

describe("task event error styling", () => {
  it("marks failed and cancelled task terminal messages as errors", () => {
    const { actions, rt } = createHarness();

    actions.onTaskEvent({
      event: "task:failed",
      data: { task: makeTask({ status: "failed" }), error: "boom" },
    });
    actions.onTaskEvent({
      event: "task:cancelled",
      data: makeTask({ status: "cancelled" }),
    });

    expect(rt.messages.value).toEqual([]);
    expect(rt.laneStatus.value).toEqual({ kind: "error", message: "[已终止]" });
  });
});
