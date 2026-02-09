import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import type { TaskBundleDraft } from "../api/types";

describe("TaskBundleDraftPanel", () => {
  it("renders drafts and emits actions", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");

    const draft: TaskBundleDraft = {
      id: "d-1",
      workspaceRoot: "/tmp/ws",
      requestId: "r1",
      status: "draft",
      bundle: { version: 1, requestId: "r1", tasks: [{ prompt: "p1" }] },
      createdAt: 1,
      updatedAt: 2,
      approvedAt: null,
      approvedTaskIds: [],
      lastError: null,
    };

    const wrapper = mount(TaskBundleDraftPanel, { props: { drafts: [draft], busy: false, error: null } });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("任务草稿");
    expect(wrapper.text()).toContain("1");

    await wrapper.get('[data-testid="task-bundle-draft-approve"]').trigger("click");
    expect(wrapper.emitted("approve")?.[0]).toEqual([{ id: "d-1", runQueue: false }]);

    await wrapper.get('[data-testid="task-bundle-draft-edit"]').trigger("click");
    await wrapper.vm.$nextTick();

    const textarea = wrapper.get('[data-testid="task-bundle-draft-editor-textarea"]');
    await textarea.setValue("{");
    await wrapper.get('[data-testid="task-bundle-draft-editor-save"]').trigger("click");
    expect(wrapper.get('[data-testid="task-bundle-draft-editor-error"]').text()).toContain("JSON");

    await textarea.setValue(JSON.stringify({ version: 1, tasks: [{ prompt: "p2" }] }));
    await wrapper.get('[data-testid="task-bundle-draft-editor-save"]').trigger("click");
    expect(wrapper.emitted("update")?.length).toBe(1);

    await wrapper.get('[data-testid="task-bundle-draft-delete"]').trigger("click");
    expect(wrapper.emitted("delete")?.[0]).toEqual(["d-1"]);
  });
});
