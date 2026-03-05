import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import type { ModelConfig } from "../api/types";

import MainChat from "../components/MainChat.vue";

function makeModel(id: string, displayName: string, provider: string): ModelConfig {
  return {
    id,
    displayName,
    provider,
    isEnabled: true,
    isDefault: false,
  };
}

describe("MainChat model selector", () => {
  const baseProps = {
    messages: [],
    queuedPrompts: [],
    pendingImages: [],
    connected: true,
    busy: false,
  } as const;

  it("renders agent/model labels without appending ids", () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai")],
        modelId: "gpt-4.1",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    const agentSelect = wrapper.find('select[aria-label="Select agent"]');
    expect(agentSelect.exists()).toBe(true);
    expect(agentSelect.text()).toContain("Codex");
    expect(agentSelect.text()).not.toContain("(codex)");

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect(modelSelect.exists()).toBe(true);
    expect(modelSelect.text()).toContain("GPT-4.1");
    expect(modelSelect.text()).not.toContain("(gpt-4.1)");

    const modelOptions = modelSelect.findAll("option").map((opt) => opt.attributes("value"));
    expect(modelOptions).not.toContain("auto");

    wrapper.unmount();
  });

  it("defaults to the first available model when current is unset", async () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai"), makeModel("gpt-4o", "GPT-4o", "openai")],
        modelId: "auto",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("gpt-4.1");
    wrapper.unmount();
  });

  it("falls back to the first filtered model for the active agent", async () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [
          { id: "claude", name: "Claude", ready: true },
          { id: "codex", name: "Codex", ready: true },
        ],
        activeAgentId: "claude",
        models: [
          makeModel("gpt-4.1", "GPT-4.1", "openai"),
          makeModel("claude-3.5-sonnet", "Claude Sonnet", "anthropic"),
        ],
        modelId: "gpt-4.1",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("claude-3.5-sonnet");
    wrapper.unmount();
  });

  it("does not emit setModel when the model list is empty", async () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [],
        modelId: "auto",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")).toBeUndefined();

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect(modelSelect.exists()).toBe(true);
    expect(modelSelect.attributes("disabled")).toBeDefined();
    expect(modelSelect.text()).toContain("No models");

    wrapper.unmount();
  });
});

