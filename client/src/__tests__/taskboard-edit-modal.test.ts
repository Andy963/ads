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
    modelParams: overrides.modelParams ?? null,
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

async function expandStage(wrapper: ReturnType<typeof mount>, stage: "backlog" | "in_progress" | "in_review" | "done"): Promise<void> {
  const container = wrapper.get(`[data-testid="task-stage-${stage}"]`);
  await container.get("button.stageHeader").trigger("click");
  await wrapper.vm.$nextTick();
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

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("继承上下文");

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
        reviewRequired: false,
      },
    });

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("starts with all task stages collapsed", async () => {
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
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll(".item")).toHaveLength(0);
    expect(wrapper.get('[data-testid="task-stage-backlog"] .stageToggleIcon').classes()).toContain("collapsed");
    expect(wrapper.get('[data-testid="task-stage-backlog"]').text()).toContain("待办");
    expect(wrapper.get('[data-testid="task-stage-backlog"]').text()).toContain("1");

    wrapper.unmount();
  });

  it("re-collapses stages after workspace switch", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "pending" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        workspaceRoot: "/tmp/ws-a",
        agents,
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();

    await expandStage(wrapper, "backlog");
    expect(wrapper.findAll(".item")).toHaveLength(1);

    await wrapper.setProps({ workspaceRoot: "/tmp/ws-b" });
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll(".item")).toHaveLength(0);
    expect(wrapper.get('[data-testid="task-stage-backlog"] .stageToggleIcon').classes()).toContain("collapsed");

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

    await expandStage(wrapper, "backlog");
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

    await expandStage(wrapper, "backlog");
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
        reviewRequired: false,
      },
    });

    wrapper.unmount();
  });

  it("derives a title from the prompt when the title is blank", async () => {
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

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="task-edit-title"]').setValue("   ");
    const prompt = `\n  abcdefghijklmnopqrstuvwxyz0123456789 \nsecond line`;
    await wrapper.find('[data-testid="task-edit-prompt"]').setValue(prompt);

    await wrapper.find('[data-testid="task-edit-modal-save"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toEqual({
      id: "t-1",
      updates: {
        title: "abcdefghijklmnopqrstuvwxyz012345…",
        prompt: prompt.trim(),
        agentId: "codex",
        priority: 0,
        maxRetries: 3,
        reviewRequired: false,
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

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-edit-modal"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps completed tasks visible in the Done stage", async () => {
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
    await wrapper.vm.$nextTick();

    await expandStage(wrapper, "done");
    expect(wrapper.findAll(".item")).toHaveLength(1);
    expect(wrapper.find('[data-testid="task-stage-done"]').text()).toContain("已完成");

    wrapper.unmount();
  });

  it("backfills bootstrap config in the editor and emits it on save", async () => {
    const task = makeTask({
      id: "t-1",
      title: "My title",
      prompt: "Hello",
      status: "pending",
      modelParams: { bootstrap: { enabled: true, projectRef: "/tmp/project", maxIterations: 7 } },
    });

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

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    const toggle = wrapper.find('[data-testid="task-edit-bootstrap-toggle"]');
    expect((toggle.element as HTMLInputElement).checked).toBe(true);

    const project = wrapper.find('[data-testid="task-edit-bootstrap-project"]');
    expect((project.element as HTMLInputElement).value).toBe("/tmp/project");

    const iterations = wrapper.find('[data-testid="task-edit-bootstrap-max-iterations"]');
    expect((iterations.element as HTMLInputElement).value).toBe("7");

    await wrapper.find('[data-testid="task-edit-modal-save"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toEqual({
      id: "t-1",
      updates: {
        title: "My title",
        prompt: "Hello",
        agentId: "codex",
        priority: 0,
        maxRetries: 3,
        reviewRequired: false,
        bootstrap: { enabled: true, projectRef: "/tmp/project", maxIterations: 7 },
      },
    });

    wrapper.unmount();
  });

  it("allows clearing bootstrap config via the editor toggle", async () => {
    const task = makeTask({
      id: "t-1",
      title: "My title",
      prompt: "Hello",
      status: "pending",
      modelParams: { bootstrap: { enabled: true, projectRef: "/tmp/project", maxIterations: 7 } },
    });

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

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    const toggle = wrapper.find('[data-testid="task-edit-bootstrap-toggle"]');
    await toggle.setValue(false);

    await wrapper.find('[data-testid="task-edit-modal-save"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toEqual({
      id: "t-1",
      updates: {
        title: "My title",
        prompt: "Hello",
        agentId: "codex",
        priority: 0,
        maxRetries: 3,
        reviewRequired: false,
        bootstrap: null,
      },
    });

    wrapper.unmount();
  });

  it("falls back to Auto when the task agent is not ready", async () => {
    const task = makeTask({ id: "t-1", title: "My title", prompt: "Hello", status: "pending", agentId: "gemini" });

    const wrapper = mount(TaskBoard, {
      props: {
        tasks: [task],
        agents: [
          { id: "gemini", name: "Gemini", ready: false, error: "missing api key" },
          { id: "codex", name: "Codex", ready: true },
        ],
        activeAgentId: "codex",
        selectedId: null,
        queueStatus: null,
        canRunSingle: true,
        runBusyIds: new Set<string>(),
      },
      attachTo: document.body,
    });

    await expandStage(wrapper, "backlog");
    await wrapper.find('[data-testid="task-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="task-edit-modal-save"]').trigger("click");
    await wrapper.vm.$nextTick();

    const updates = wrapper.emitted("update");
    expect(updates).toBeTruthy();
    expect(updates?.[0]?.[0]).toMatchObject({
      id: "t-1",
      updates: expect.objectContaining({ agentId: null }),
    });

    wrapper.unmount();
  });
});
