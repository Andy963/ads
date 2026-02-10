import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import TaskBoard from "../components/TaskBoard.vue";
import type { Task } from "../api/types";

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "Do something",
    model: overrides.model ?? "auto",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    agentId: overrides.agentId ?? null,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    createdAt: overrides.createdAt ?? now,
    queuedAt: overrides.queuedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("TaskBoard edit modal", () => {
  const agents = [{ id: "codex", name: "Codex", ready: true }];

  it("opens a modal editor and emits updates on save", async () => {
    const longPrompt = `Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6`;
    const task = makeTask({ id: "t-1", title: "My title", prompt: longPrompt, status: "pending" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);

    const promptEl = wrapper.find('[data-testid="task-edit-prompt"]');
    expect((promptEl.element as HTMLTextAreaElement).value).toBe(longPrompt);

    const nextPrompt = `${longPrompt}\nLine 7`;
    await promptEl.setValue(nextPrompt);

    await wrapper.find('[data-testid="task-edit-modal-save"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toEqual({
      id: "t-1",
      updates: {
        title: "My title",
        prompt: nextPrompt,
        agentId: "codex",
        priority: 0,
        maxRetries: 3,
        inheritContext: true,
      },
    });

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("closes without emitting updates on cancel", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "pending" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);

    await wrapper.find('[data-testid="task-edit-modal-cancel"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("update")).toBeFalsy();
    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("emits update-and-run on save-and-run", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "pending" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);

    await wrapper.find('[data-testid="task-edit-modal-save-and-run"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update-and-run");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toEqual({
      id: "t-1",
      updates: {
        title: "My title",
        prompt: "Hello",
        agentId: "codex",
        priority: 0,
        maxRetries: 3,
        inheritContext: true,
      },
    });

    wrapper.unmount();
  });

  it("allows editing a cancelled task", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "cancelled" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows rerun flow for a completed task", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "completed" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await wrapper.find('button[title="重新执行"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="task-edit-modal-save"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-edit-modal-save-and-run"]').text()).toContain("重新执行");

    wrapper.unmount();
  });
});
