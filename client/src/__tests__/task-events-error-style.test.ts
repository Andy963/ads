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

  it("applies review state updates to the task board and deduplicates notifications", () => {
    const { actions, rt } = createHarness();
    const review = {
      required: true,
      status: "approved",
      rootTaskId: "root-1",
      pullRequestNumber: 85,
      pullRequestUrl: "https://github.com/acme/project/pull/85",
      reviewTaskId: "review-1",
      reviewerModelConfigId: "reviewer-config",
      reviewerModelId: "reviewer-model",
      reviewerModelDisplayName: "Reviewer",
      reviewerAgentId: "reviewer",
      reviewStartedAt: 1,
      reviewedAt: 2,
      conclusion: "Looks good.",
      feedback: null,
      output: "REVIEW_STATUS: approved",
      artifactId: null,
      reworkRound: 0,
      maxReworkRounds: 2,
      automationMode: "auto_with_fuse",
      stateReason: null,
      reworkTaskIds: [],
      controlState: "automatic",
    } as const;
    rt.tasks.value = [
      makeTask({ id: "root-1", review: { ...review, status: "in_review" } as any }),
      makeTask({ id: "review-1", review: { ...review, status: "in_review" } as any }),
    ];

    const payload = {
      event: "review:updated" as const,
      data: {
        taskId: "root-1",
        rootTaskId: "root-1",
        event: "approved",
        message: "Review approved.",
        review,
      },
    };
    actions.onTaskEvent(payload);
    actions.onTaskEvent(payload);

    expect(rt.tasks.value.every((task) => task.review?.status === "approved")).toBe(true);
    expect(rt.messages.value).toHaveLength(1);
    expect(rt.messages.value[0]?.content).toBe("[Code Review] Review approved.");
  });
});
