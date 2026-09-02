import { describe, it, expect } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import type { TaskBundleDraft } from "../api/types";

describe("TaskBundleDraftPanel", () => {
  it("only exposes task editing actions", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");

    const draft: TaskBundleDraft = {
      id: "d-1",
      workspaceRoot: "/tmp/ws",
      requestId: "r1",
      status: "draft",
      bundle: {
        version: 1,
        requestId: "r1",
        issueRef: "docs/issue/r1",
        specRef: "docs/spec/r1",
        tasks: [{ prompt: "p1" }],
      },
      createdAt: 1,
      updatedAt: 2,
      approvedAt: null,
      approvedTaskIds: [],
      lastError: null,
    };

    const wrapper = mount(TaskBundleDraftPanel, {
      props: {
        drafts: [draft],
        busy: false,
        error: null,
      },
    });
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="task-bundle-draft-d-1"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="task-bundle-draft-task-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="task-bundle-draft-spec-ref"]').text()).toContain("docs/spec/r1");
    expect(wrapper.get('[data-testid="task-bundle-draft-issue-ref"]').text()).toContain("docs/issue/r1");
    expect(wrapper.find('[data-testid="task-bundle-draft-missing-spec"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-bundle-draft-tab-requirements"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-bundle-draft-tab-design"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-bundle-draft-tab-implementation"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-bundle-draft-spec-panel"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="task-bundle-draft-save-task"]').text()).toBe("保存任务");
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows prompt-only drafts without local work-item references", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");

    const draft: TaskBundleDraft = {
      id: "d-nospec",
      workspaceRoot: "/tmp/ws",
      requestId: "r-nospec",
      status: "draft",
      bundle: { version: 1, requestId: "r-nospec", tasks: [{ prompt: "p1" }] },
      createdAt: 1,
      updatedAt: 2,
      approvedAt: null,
      approvedTaskIds: [],
      lastError: null,
    };

    const wrapper = mount(TaskBundleDraftPanel, {
      props: { drafts: [draft], busy: false, error: null },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="task-bundle-draft-row-spec"]').exists()).toBe(false);

    await wrapper.get('[data-testid="task-bundle-draft-d-nospec"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="task-bundle-draft-spec-ref"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="task-bundle-draft-missing-spec"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(false);
    expect((wrapper.get('[data-testid="task-bundle-draft-approve-run"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the bound spec filename in the draft list", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");

    const draft: TaskBundleDraft = {
      id: "d-spec",
      workspaceRoot: "/tmp/ws",
      requestId: "r-spec",
      status: "draft",
      bundle: {
        version: 1,
        requestId: "r-spec",
        issueRef: "docs/issue/telegram-watchdog",
        specRef: "docs/spec/telegram-watchdog",
        tasks: [{ prompt: "p1" }],
      },
      createdAt: 1,
      updatedAt: 2,
      approvedAt: null,
      approvedTaskIds: [],
      lastError: null,
    };

    const wrapper = mount(TaskBundleDraftPanel, {
      props: { drafts: [draft], busy: false, error: null },
    });
    await wrapper.vm.$nextTick();

    const row = wrapper.get('[data-testid="task-bundle-draft-row-spec"]');
    expect(row.text()).toContain("telegram-watchdog");
    expect(row.attributes("title")).toBe("docs/issue/telegram-watchdog ↔ docs/spec/telegram-watchdog");
  });

  it("edits a single task and normalizes multi-task drafts on save", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");

    const draft: TaskBundleDraft = {
      id: "d-1",
      workspaceRoot: "/tmp/ws",
      requestId: "r1",
      status: "draft",
      bundle: {
        version: 1,
        requestId: "r1",
        issueRef: "docs/issue/r1",
        specRef: "docs/spec/r1",
        tasks: [
          { title: "Task A", prompt: "p1" },
          { title: "Task B", prompt: "p2" },
        ],
      },
      createdAt: 1,
      updatedAt: 2,
      approvedAt: null,
      approvedTaskIds: [],
      lastError: null,
    };

    const wrapper = mount(TaskBundleDraftPanel, {
      props: { drafts: [draft], busy: false, error: null },
    });
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="task-bundle-draft-d-1"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="task-bundle-draft-task-normalization-warning"]').exists()).toBe(true);
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(true);

    const promptField = wrapper.get('[data-testid="task-bundle-draft-task-prompt"]');
    await promptField.setValue("");
    await wrapper.get('[data-testid="task-bundle-draft-save-task"]').trigger("click");
    expect(wrapper.get('[data-testid="task-bundle-draft-error"]').text()).toContain("不能为空");

    await promptField.setValue("p1 updated");
    await wrapper.get('[data-testid="task-bundle-draft-save-task"]').trigger("click");

    expect(wrapper.emitted("update")?.[0]?.[0]).toEqual({
      id: "d-1",
      bundle: {
        version: 1,
        requestId: "r1",
        issueRef: "docs/issue/r1",
        specRef: "docs/spec/r1",
        tasks: [{ title: "Task A", prompt: "p1 updated" }],
      },
    });
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(false);
  });
});
