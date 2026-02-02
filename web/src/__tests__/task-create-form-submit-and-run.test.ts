import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import TaskCreateForm from "../components/TaskCreateForm.vue";
import type { ModelConfig } from "../api/types";

describe("TaskCreateForm submit-and-run", () => {
  const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];

  it("does not submit on Enter", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        models,
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
        models,
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
        models,
        workspaceRoot: "",
      },
    });

    await wrapper.find("textarea").setValue("Do something");
    await wrapper.find('[data-testid="task-create-submit-and-run"]').trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toEqual({
      prompt: "Do something",
      model: "auto",
      priority: 0,
      maxRetries: 3,
    });

    wrapper.unmount();
  });
});
