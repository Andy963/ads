import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import TaskCreateForm from "../components/TaskCreateForm.vue";
import type { ModelConfig } from "../api/types";

describe("TaskCreateForm submit-and-run", () => {
  const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];

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

