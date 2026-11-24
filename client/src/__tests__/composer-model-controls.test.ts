import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import type { ModelConfig } from "../api/types";

function model(): ModelConfig {
  return {
    id: "m1",
    displayName: "Model One",
    provider: "openai",
    isEnabled: true,
    isDefault: true,
    configJson: { reasoningEfforts: ["medium", "high"] },
  };
}

describe("composer model controls", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 240, 32, 32));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("does not render the full-width model selector row and exposes Model & reasoning in the action menu", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model()],
        modelId: "m1",
        modelReasoningEffort: "medium",
      },
      attachTo: document.body,
    });

    // Acceptance Criterion: The composer no longer renders the full-width model selector row above the input.
    expect(wrapper.find('[data-testid="composer-model-controls"]').exists()).toBe(false);

    // Open the composer action sheet (+)
    await wrapper.get('[data-testid="composer-actions-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();

    const modelAction = document.body.querySelector('[data-testid="action-model-settings"]') as HTMLButtonElement | null;
    expect(modelAction).not.toBeNull();
    expect(modelAction?.disabled).toBe(false);
    expect(modelAction?.textContent).toContain("Model & reasoning");
    expect(modelAction?.textContent).toContain("Model One · Med");

    // Activating the entry opens the model picker
    modelAction?.click();
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector('[data-testid="model-picker-sheet"]')).not.toBeNull();

    const selector = wrapper.findComponent({ name: "MainChatModelSelectors" });
    selector.vm.$emit("setModel", "m1");
    selector.vm.$emit("setReasoningEffort", "high");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]).toEqual(["m1"]);
    expect(wrapper.emitted("setReasoningEffort")?.[0]).toEqual(["high"]);

    // Dismissing the picker restores focus to the trigger
    const doneBtn = document.body.querySelector('[data-testid="model-picker-done"]') as HTMLButtonElement | null;
    doneBtn?.click();
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="composer-actions-toggle"]').element);

    wrapper.unmount();
    document.body.innerHTML = "";
  });

  it("disables the model action entry while busy or input-locked", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
        inputLocked: false,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model()],
        modelId: "m1",
        modelReasoningEffort: "high",
      },
      attachTo: document.body,
    });

    await wrapper.get('[data-testid="composer-actions-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();

    const modelAction = document.body.querySelector('[data-testid="action-model-settings"]') as HTMLButtonElement | null;
    expect(modelAction).not.toBeNull();
    expect(modelAction?.disabled).toBe(true);
    wrapper.unmount();
    document.body.innerHTML = "";
  });

  it("shows an unavailable state when no models exist", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [],
      },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="composer-actions-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();
    const summary = document.body.querySelector('[data-testid="action-model-summary"]');
    expect(summary?.textContent).toBe("无可用模型");
    wrapper.unmount();
    document.body.innerHTML = "";
  });
});
