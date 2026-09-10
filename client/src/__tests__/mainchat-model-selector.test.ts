import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import type { ModelConfig } from "../api/types";

import MainChat from "../components/MainChat.vue";
import MainChatModelSelectors from "../components/MainChatModelSelectors.vue";

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

  const selectorBaseProps = {
    connected: true,
    busy: false,
  } as const;

  it("renders the model label without an agent selector or appended id", () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai")],
        modelId: "gpt-4.1",
      },
    });

    const agentSelect = wrapper.find('select[aria-label="Select agent"]');
    expect(agentSelect.exists()).toBe(false);

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect(modelSelect.exists()).toBe(true);
    expect(modelSelect.text()).toContain("GPT-4.1");
    expect(modelSelect.text()).not.toContain("(gpt-4.1)");

    const modelOptions = wrapper.findAll('[data-testid="chat-model-option"]').map((option) => option.attributes("data-model-id"));
    expect(modelOptions).not.toContain("auto");

    wrapper.unmount();
  });

  it("renders reasoning efforts for any active agent with model-provided options", () => {
    const model = makeModel("custom-model", "Custom Model", "custom");
    model.configJson = {
      allowedAgents: ["custom"],
      reasoningEfforts: ["minimal", "high"],
    };
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "custom", name: "Custom", ready: true }],
        activeAgentId: "custom",
        models: [model],
        modelId: "custom-model",
      },
    });

    const effortSelect = wrapper.find('[data-testid="chat-reasoning-effort"]');
    expect(effortSelect.exists()).toBe(true);
    expect(effortSelect.findAll("[data-reasoning-effort]").map((option) => option.attributes("data-reasoning-effort"))).toEqual(["minimal", "high"]);

    wrapper.unmount();
  });

  it("exposes independent native dropdowns for model and reasoning changes", async () => {
    const model = makeModel("gpt-5.6", "GPT-5.6", "openai");
    model.configJson = { reasoningEfforts: ["low", "high"] };
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model, makeModel("gpt-4.1", "GPT-4.1", "openai")],
        modelId: "gpt-5.6",
        modelReasoningEffort: "low",
      },
    });

    const modelSelect = wrapper.get('select[aria-label="Model"]');
    const effortSelect = wrapper.get('select[aria-label="Reasoning effort"]');
    expect(wrapper.findAll("select")).toHaveLength(2);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect((modelSelect.element as HTMLSelectElement).value).toBe("gpt-5.6");
    expect((effortSelect.element as HTMLSelectElement).value).toBe("low");

    await modelSelect.setValue("gpt-4.1");
    expect(wrapper.emitted("setModel")?.at(-1)?.[0]).toBe("gpt-4.1");
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();

    await effortSelect.setValue("high");
    expect(wrapper.emitted("setReasoningEffort")?.at(-1)?.[0]).toBe("high");
    expect(wrapper.emitted("setModel")).toHaveLength(1);
    wrapper.unmount();
  });

  it("offers the extended Codex reasoning efforts when a model has no override", () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-5.6", "GPT-5.6", "openai")],
        modelId: "gpt-5.6",
      },
    });

    expect(wrapper.find('[data-testid="chat-reasoning-effort"]').findAll("[data-reasoning-effort]").map((option) => option.attributes("data-reasoning-effort"))).toEqual([
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    wrapper.unmount();
  });

  it("reads Codex reasoning efforts from the selected model config", () => {
    const model = makeModel("gpt-5.6-sol", "GPT-5.6", "openai");
    model.configJson = {
      reasoningEfforts: ["medium", "high", "xhigh", "max", "ultra"],
    };
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model],
        modelId: "gpt-5.6-sol",
        modelReasoningEffort: "ultra",
      },
    });

    const effortSelect = wrapper.find('[data-testid="chat-reasoning-effort"]');
    expect((effortSelect.element as HTMLSelectElement).value).toBe("ultra");
    expect(effortSelect.findAll("[data-reasoning-effort]").map((option) => option.attributes("data-reasoning-effort"))).toEqual([
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
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "claude", name: "Claude", ready: true }],
        activeAgentId: "claude",
        models: [model],
        modelId: "claude-opus-4-8",
        modelReasoningEffort: "max",
      },
    });

    const effortSelect = wrapper.find('[data-testid="chat-reasoning-effort"]');
    expect((effortSelect.element as HTMLSelectElement).value).toBe("max");
    expect(effortSelect.findAll("[data-reasoning-effort]").map((option) => option.attributes("data-reasoning-effort"))).toEqual([
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
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai"), makeModel("gpt-4o", "GPT-4o", "openai")],
        modelId: "auto",
      },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("gpt-4.1");
    wrapper.unmount();
  });

  it("falls back to the first filtered model for the active agent", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
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
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("claude-3.5-sonnet");
    wrapper.unmount();
  });

  it("shows only models supported by the active CLI and never switches CLI from model selection", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude Code", ready: true },
        ],
        activeAgentId: "codex",
        models: [
          makeModel("gpt-4.1", "GPT-4.1", "openai"),
          makeModel("claude-opus-5[1m]", "Claude Opus 5", "anthropic"),
        ],
        modelId: "gpt-4.1",
      },
    });

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect(wrapper.findAll('[data-testid="chat-model-option"]').map((option) => option.attributes("data-model-id"))).toEqual(["gpt-4.1"]);
    expect(modelSelect.text()).not.toContain("Claude Opus 5");

    await modelSelect.setValue("gpt-4.1");

    expect(wrapper.emitted("switchAgent")).toBeUndefined();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("gpt-4.1");
    wrapper.unmount();
  });

  it("does not expose models when no CLI is ready", () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [
          { id: "codex", name: "Codex", ready: false },
          { id: "claude", name: "Claude Code", ready: false },
        ],
        activeAgentId: "codex",
        models: [
          makeModel("gpt-4.1", "GPT-4.1", "openai"),
          makeModel("claude-opus-5[1m]", "Claude Opus 5", "anthropic"),
        ],
        modelId: "gpt-4.1",
      },
    });

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect((modelSelect.element as HTMLSelectElement).disabled).toBe(true);
    expect(wrapper.findAll('[data-testid="chat-model-option"]')).toHaveLength(0);
    expect(modelSelect.text()).toContain("No models");
    expect(modelSelect.text()).not.toContain("GPT-4.1");
    expect(modelSelect.text()).not.toContain("Claude Opus 5");
    expect((wrapper.get('[data-testid="chat-reasoning-effort"]').element as HTMLSelectElement).disabled).toBe(true);

    wrapper.unmount();
  });

  it("prefers the active agent default model when the current model is unset", async () => {
    const fable = makeModel("claude-fable-5[1m]", "Claude Fable 5", "anthropic");
    const opus = makeModel("claude-opus-5[1m]", "Claude Opus 5", "anthropic");
    opus.isDefault = true;
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "claude", name: "Claude Code", ready: true }],
        activeAgentId: "claude",
        models: [fable, opus],
        modelId: "auto",
      },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")?.[0]?.[0]).toBe("claude-opus-5[1m]");
    wrapper.unmount();
  });

  it("does not emit setModel when the model list is empty", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [],
        modelId: "auto",
      },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")).toBeUndefined();

    const modelSelect = wrapper.find('[data-testid="chat-model-select"]');
    expect(modelSelect.exists()).toBe(true);
    expect((modelSelect.element as HTMLSelectElement).disabled).toBe(true);
    expect(modelSelect.text()).toContain("No models");

    wrapper.unmount();
  });

  it("preserves an unknown model preference after the composer unlocks", async () => {
    const model = makeModel("gpt-4.1", "GPT-4.1", "openai");
    model.configJson = {
      reasoningEfforts: ["medium", "high"],
    };
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        inputLocked: true,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [model],
        modelId: "removed-model",
        modelReasoningEffort: "xhigh",
      },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("setModel")).toBeUndefined();
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();

    await wrapper.setProps({ inputLocked: false });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("setModel")).toBeUndefined();
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();
    expect((wrapper.get('[data-testid="chat-model-select"]').element as HTMLSelectElement).value).toBe("removed-model");
    expect((wrapper.get('[data-testid="chat-reasoning-effort"]').element as HTMLSelectElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it.each([
    { busy: true },
    { inputLocked: true },
    { connected: false },
  ])("blocks both dropdown changes when restricted by %j", async (restriction) => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        ...restriction,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai"), makeModel("gpt-4o", "GPT-4o", "openai")],
        modelId: "gpt-4.1",
        modelReasoningEffort: "high",
      },
    });
    const modelSelect = wrapper.get('[data-testid="chat-model-select"]');
    const effortSelect = wrapper.get('[data-testid="chat-reasoning-effort"]');
    expect((modelSelect.element as HTMLSelectElement).disabled).toBe(true);
    expect((effortSelect.element as HTMLSelectElement).disabled).toBe(true);
    await modelSelect.setValue("gpt-4o");
    await effortSelect.setValue("ultra");
    expect(wrapper.emitted("setModel")).toBeUndefined();
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();
    wrapper.unmount();
  });

  it("updates the selected native values when active-lane props change", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        ...selectorBaseProps,
        agents: [{ id: "codex", name: "Codex", ready: true }],
        activeAgentId: "codex",
        models: [makeModel("gpt-4.1", "GPT-4.1", "openai"), makeModel("gpt-4o", "GPT-4o", "openai")],
        modelId: "gpt-4.1",
        modelReasoningEffort: "high",
      },
    });
    await wrapper.setProps({ modelId: "gpt-4o", modelReasoningEffort: "ultra" });
    expect((wrapper.get('[data-testid="chat-model-select"]').element as HTMLSelectElement).value).toBe("gpt-4o");
    expect((wrapper.get('[data-testid="chat-reasoning-effort"]').element as HTMLSelectElement).value).toBe("ultra");
    expect(wrapper.emitted("setModel")).toBeUndefined();
    expect(wrapper.emitted("setReasoningEffort")).toBeUndefined();
    wrapper.unmount();
  });
});
