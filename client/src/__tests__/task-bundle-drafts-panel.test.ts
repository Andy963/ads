import { describe, it, expect, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import type {
  TaskBundleDraft,
  TaskBundleDraftSpecDocument,
  TaskBundleDraftSpecSummary,
} from "../api/types";

describe("TaskBundleDraftPanel", () => {
  it("defaults to the task tab and lazy loads spec only after switching tabs", async () => {
    const { default: TaskBundleDraftPanel } = await import("../components/TaskBundleDraftPanel.vue");
    const loadSpecSummary = vi.fn<() => Promise<TaskBundleDraftSpecSummary>>().mockResolvedValue({
      specRef: "docs/spec/r1",
      files: [
        { key: "requirements", fileName: "requirements.md", missing: false },
        { key: "design", fileName: "design.md", missing: false },
        { key: "implementation", fileName: "implementation.md", missing: true },
      ],
    });
    const loadSpecFile = vi
      .fn<(payload: { id: string; file: string }) => Promise<TaskBundleDraftSpecDocument>>()
      .mockImplementation(async ({ file }) => {
        if (file === "design") {
          return {
            specRef: "docs/spec/r1",
            key: "design",
            fileName: "design.md",
            content: "# Design\nDesign\n",
            missing: false,
          };
        }
        return {
          specRef: "docs/spec/r1",
          key: file as TaskBundleDraftSpecDocument["key"],
          fileName: `${file}.md`,
          content: "",
          missing: file === "implementation",
        };
      });
    const saveSpecFile = vi
      .fn<(payload: { id: string; file: string; update: { content: string } }) => Promise<TaskBundleDraftSpecDocument>>()
      .mockImplementation(async ({ file, update }) => ({
        specRef: "docs/spec/r1",
        key: file as TaskBundleDraftSpecDocument["key"],
        fileName: `${file}.md`,
        content: `${update.content}\n`,
        missing: false,
      }));

    const draft: TaskBundleDraft = {
      id: "d-1",
      workspaceRoot: "/tmp/ws",
      requestId: "r1",
      status: "draft",
      bundle: { version: 1, requestId: "r1", specRef: "docs/spec/r1", tasks: [{ prompt: "p1" }] },
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
        loadSpecSummary,
        loadSpecFile,
        saveSpecFile,
      },
    });
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="task-bundle-draft-d-1"]').trigger("click");
    await flushPromises();

    expect(loadSpecSummary).not.toHaveBeenCalled();
    expect(loadSpecFile).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="task-bundle-draft-task-panel"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="task-bundle-draft-task-prompt-"]')).toHaveLength(0);

    await wrapper.get('[data-testid="task-bundle-draft-tab-design"]').trigger("click");
    await flushPromises();

    expect(loadSpecSummary).toHaveBeenCalledWith("d-1");
    expect(loadSpecFile).toHaveBeenCalledWith({ id: "d-1", file: "design" });

    const designField = wrapper.get('[data-testid="task-bundle-draft-spec-design"]');
    await designField.setValue("# Design\nDesign 2");
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(true);

    await wrapper.get('[data-testid="task-bundle-draft-save-current-tab"]').trigger("click");
    await flushPromises();

    expect(saveSpecFile).toHaveBeenCalledWith({
      id: "d-1",
      file: "design",
      update: { content: "# Design\nDesign 2" },
    });
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(false);
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
    expect(wrapper.find('[data-testid="task-bundle-draft-task-title"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="task-bundle-draft-task-title-"]')).toHaveLength(0);

    const promptField = wrapper.get('[data-testid="task-bundle-draft-task-prompt"]');
    await promptField.setValue("");
    await wrapper.get('[data-testid="task-bundle-draft-save-current-tab"]').trigger("click");
    expect(wrapper.get('[data-testid="task-bundle-draft-error"]').text()).toContain("不能为空");

    await promptField.setValue("p1 updated");
    await wrapper.get('[data-testid="task-bundle-draft-save-current-tab"]').trigger("click");

    expect(wrapper.emitted("update")?.[0]?.[0]).toEqual({
      id: "d-1",
      bundle: { version: 1, requestId: "r1", tasks: [{ title: "Task A", prompt: "p1 updated" }] },
    });
    expect((wrapper.get('[data-testid="task-bundle-draft-approve"]').element as HTMLButtonElement).disabled).toBe(false);
  });
});
