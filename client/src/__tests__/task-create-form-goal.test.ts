import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import TaskCreateForm from "../components/TaskCreateForm.vue";

describe("TaskCreateForm goal mode", () => {
  it("does not include goal fields when goal toggle is off", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
      },
    });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("do something");
    const submitBtn = wrapper.find('[data-testid="task-create-submit-and-run"]');
    await submitBtn.trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    const payload = (emitted![0] as [Record<string, unknown>])[0];
    expect(payload).not.toHaveProperty("goalMode");
    expect(payload).not.toHaveProperty("goalObjective");
    expect(payload).not.toHaveProperty("goalTokenBudget");
    wrapper.unmount();
  });

  it("emits goalMode + goalObjective + goalTokenBudget when toggle is on", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
      },
    });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("write a poem");

    const goalToggle = wrapper.find('[data-testid="task-create-goal-toggle"]');
    await goalToggle.setValue(true);

    const objectiveEl = wrapper.find('[data-testid="task-create-goal-objective"]');
    await objectiveEl.setValue("write 3 stanzas");
    const budgetEl = wrapper.find('[data-testid="task-create-goal-token-budget"]');
    await budgetEl.setValue("5000");

    const submitBtn = wrapper.find('[data-testid="task-create-submit-and-run"]');
    await submitBtn.trigger("click");

    const emitted = wrapper.emitted("submit-and-run");
    expect(emitted).toBeTruthy();
    const payload = (emitted![0] as [Record<string, unknown>])[0];
    expect(payload.goalMode).toBe(true);
    expect(payload.goalObjective).toBe("write 3 stanzas");
    expect(payload.goalTokenBudget).toBe(5000);
    wrapper.unmount();
  });

  it("sends goalObjective=null when objective field is blank", async () => {
    const wrapper = mount(TaskCreateForm, {
      props: {
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
      },
    });

    await wrapper.find("textarea").setValue("only prompt");
    await wrapper.find('[data-testid="task-create-goal-toggle"]').setValue(true);
    // Leave objective blank
    await wrapper.find('[data-testid="task-create-submit-and-run"]').trigger("click");
    const payload = (wrapper.emitted("submit-and-run")![0] as [Record<string, unknown>])[0];
    expect(payload.goalMode).toBe(true);
    expect(payload.goalObjective).toBeNull();
    expect(payload.goalTokenBudget).toBeNull();
    wrapper.unmount();
  });
});
