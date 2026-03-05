import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

import TaskBoard from "../components/TaskBoard.vue";
import type { ReviewSnapshot, Task } from "../api/types";
import type { ApiClient } from "../api/client";

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "Do something",
    model: overrides.model ?? "auto",
    modelParams: overrides.modelParams ?? null,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    queuedAt: overrides.queuedAt ?? null,
    promptInjectedAt: overrides.promptInjectedAt ?? null,
    inheritContext: overrides.inheritContext ?? true,
    agentId: overrides.agentId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    threadId: overrides.threadId ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    reviewRequired: overrides.reviewRequired ?? false,
    reviewStatus: overrides.reviewStatus ?? "none",
    reviewSnapshotId: overrides.reviewSnapshotId ?? null,
    reviewConclusion: overrides.reviewConclusion ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    createdAt: overrides.createdAt ?? now,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("TaskBoard review detail", () => {
  it("renders compact review badge, opens detail modal, and emits markDone", async () => {
    const task = makeTask({
      id: "t-1",
      status: "completed",
      reviewRequired: true,
      reviewStatus: "rejected",
      reviewConclusion: "needs fixes",
      reviewSnapshotId: "snap-1",
      reviewedAt: 1700000000000,
    });

    const snapshot: ReviewSnapshot = {
      id: "snap-1",
      taskId: "t-1",
      specRef: null,
      patch: { files: [], diff: "diff --git a/a b/a\n+hello\n", truncated: false },
      changedFiles: ["a"],
      lintSummary: "",
      testSummary: "",
      createdAt: 1700000000000,
    };

    const api = {
      get: vi.fn(async () => snapshot),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        api,
        workspaceRoot: "/tmp/ws",
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    expect(wrapper.text()).toContain("驳回");
    expect(wrapper.text()).not.toContain("Review:");
    expect(wrapper.find('button[title="重新执行"]').exists()).toBe(false);

    await wrapper.find("button.row-main").trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-detail-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="task-review-detail"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="task-review-conclusion"]').text()).toContain("needs fixes");

    await wrapper.find('[data-testid="task-review-mark-done"]').trigger("click");
    expect(wrapper.emitted("markDone")?.[0]?.[0]).toBe("t-1");

    await wrapper.find('[data-testid="task-review-view-notes"]').trigger("click");
    await flushPromises();

    expect(api.get).toHaveBeenCalledTimes(1);
    const calledPath = (api.get as any).mock.calls[0]?.[0] as string;
    expect(calledPath).toContain("/api/review-snapshots/snap-1");
    expect(calledPath).toContain("workspace=");

    expect(wrapper.find('[data-testid="task-review-notes-modal"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("diff --git");

    wrapper.unmount();
  });
});

