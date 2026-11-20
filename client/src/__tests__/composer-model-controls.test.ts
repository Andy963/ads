import { describe, expect, it } from "vitest";
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
  it("renders the lane model capsule in composer metadata and forwards changes", async () => {
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
    });

    expect(wrapper.get('[data-testid="composer-model-controls"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="chat-capsule-text"]').text()).toBe("Model One");
    const selector = wrapper.findComponent({ name: "MainChatModelSelectors" });
    selector.vm.$emit("setModel", "m1");
    selector.vm.$emit("setReasoningEffort", "high");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]).toEqual(["m1"]);
    expect(wrapper.emitted("setReasoningEffort")?.[0]).toEqual(["high"]);
    wrapper.unmount();
  });

  it("keeps the current model visible while busy or locked", () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
        inputLocked: true,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model()],
        modelId: "m1",
        modelReasoningEffort: "high",
      },
    });
    expect(wrapper.get('[data-testid="chat-capsule-text"]').text()).toBe("Model One");
    expect(wrapper.get('[data-testid="chat-model-capsule"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
