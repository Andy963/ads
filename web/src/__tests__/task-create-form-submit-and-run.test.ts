import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import TaskCreateForm from "../components/TaskCreateForm.vue";

describe("TaskCreateForm submit-and-run", () => {
  it("does not submit on Enter", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        workspaceRoot: "",
      },
    });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Do something");
    await textarea.trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("submit")).toBeFalsy();
    expect(wrapper.emitted("submit-and-run")).toBeFalsy();

    wrapper.unmount();
  });

  it("inserts newline on Alt+Enter", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        workspaceRoot: "",
      },
    });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Line 1");
    const el = textarea.element as HTMLTextAreaElement;
    el.setSelectionRange(6, 6);

    await textarea.trigger("keydown", { key: "Enter", altKey: true });
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("Line 1\n");
    expect(wrapper.emitted("submit")).toBeFalsy();
    expect(wrapper.emitted("submit-and-run")).toBeFalsy();

    wrapper.unmount();
  });

  it("emits submit-and-run with CreateTaskInput", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        workspaceRoot: "",
      },
    });

    await wrapper.find("textarea").setValue("Do something");
    await wrapper.find('[data-testid="task-create-submit-and-run"]').trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toEqual({
      prompt: "Do something",
      priority: 0,
      maxRetries: 3,
    });

    wrapper.unmount();
  });

  it("includes agentId when an active agent is provided", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        workspaceRoot: "",
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude", ready: true },
        ],
        activeAgentId: "claude",
      },
    });

    await wrapper.find("textarea").setValue("Do something");
    await wrapper.find('[data-testid="task-create-submit-and-run"]').trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toMatchObject({ agentId: "claude" });

    wrapper.unmount();
  });

  it("merges a pinned prompt template into the submitted prompt", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        prompts: [
          { id: "p-1", name: "Template 1", content: "Pinned content", createdAt: Date.now(), updatedAt: Date.now() },
        ],
        promptsBusy: false,
        workspaceRoot: "",
      },
    });

    await wrapper.find('[data-testid="task-create-pinned-prompt-select"]').setValue("p-1");
    await wrapper.find('[data-testid="task-create-submit-and-run"]').trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toEqual({
      title: "Template 1",
      prompt: "# Template: Template 1 (p-1)\n\nPinned content",
      priority: 0,
      maxRetries: 3,
    });

    wrapper.unmount();
  });
});
