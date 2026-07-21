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

  it("reads Codex reasoning efforts from the selected model config", () => {
    const model = makeModel("gpt-5.6-sol", "GPT-5.6", "openai");
    model.configJson = {
      reasoningEfforts: ["medium", "high", "xhigh", "max", "ultra"],
    };
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model],
        modelId: "gpt-5.6-sol",
        modelReasoningEffort: "ultra",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    const effortSelect = wrapper.find('[data-testid="chat-reasoning-effort"]');
    expect(effortSelect.attributes("value")).toBe("ultra");
    expect(effortSelect.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    wrapper.unmount();
  });

  it("shows Claude CLI effort levels from the selected model config", () => {
    const model = makeModel("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
    model.configJson = {
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        agents: [{ id: "claude", name: "Claude", ready: true }],
        activeAgentId: "claude",
        models: [model],
        modelId: "claude-opus-4-8",
        modelReasoningEffort: "max",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    const effortSelect = wrapper.find('[data-testid="chat-reasoning-effort"]');
    expect((effortSelect.element as HTMLSelectElement).value).toBe("max");
    expect(effortSelect.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    wrapper.unmount();
  });

  it("does not show execution context under user messages", () => {
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [
          {
            id: "u-1",
            role: "user",
            kind: "text",
            content: "hello",
            execution: {
              agentId: "codex",
              model: "gpt-4.1",
              modelReasoningEffort: "xhigh",
              effectiveAgentId: "claude",
              effectiveModel: "claude-sonnet",
            },
          },
        ],
        agents: [{ id: "claude", name: "Claude", ready: true }],
        activeAgentId: "claude",
        models: [makeModel("claude-sonnet", "Claude Sonnet", "anthropic")],
        modelId: "claude-sonnet",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    expect(wrapper.find(".msgExecutionMeta").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Agent:");
    expect(wrapper.text()).not.toContain("Model:");
    expect(wrapper.text()).not.toContain("Reasoning:");
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

  it("normalizes model preferences after the composer unlocks", async () => {
    const model = makeModel("gpt-4.1", "GPT-4.1", "openai");
    model.configJson = {
      reasoningEfforts: ["medium", "high"],
    };
    const wrapper = mount(MainChat, {
      props: {
        ...baseProps,
        inputLocked: true,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model],
        modelId: "removed-model",
        modelReasoningEffort: "xhigh",
      },
      global: { stubs: { MarkdownContent: true, DraggableModal: true } },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")).toBeUndefined();
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();

    await wrapper.setProps({ inputLocked: false });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("gpt-4.1");
    expect(wrapper.emitted("setReasoningEffort")?.[0]?.[0]).toBe("high");
    wrapper.unmount();
  });
});
