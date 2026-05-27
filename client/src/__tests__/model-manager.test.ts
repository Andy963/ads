import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import type { ModelConfig } from "../api/types";
import ModelManager from "../components/ModelManager.vue";

function makeModel(
  id: string,
  displayName: string,
  provider: string,
  agent: "codex" | "claude",
  modelId = id,
): ModelConfig {
  return {
    id,
    modelId,
    displayName,
    provider,
    isEnabled: true,
    isDefault: false,
    configJson: { allowedAgents: [agent] },
  };
}

async function settle(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("ModelManager", () => {
  it("loads managed models and creates a codex model with an agent scope", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"),
        {
          id: "local-model",
          displayName: "Local Model",
          provider: "local",
          isEnabled: true,
          isDefault: false,
          configJson: null,
        } satisfies ModelConfig,
      ]),
      post: vi.fn().mockResolvedValue(makeModel("model-generated", "gpt-5.2", "openai", "codex", "gpt-5.2")),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(api.get).toHaveBeenCalledWith("/api/model-configs");
    expect(wrapper.text()).toContain("Claude Sonnet");
    expect(wrapper.text()).not.toContain("Local Model");

    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("gpt-5.2");
    await wrapper.find('[data-testid="model-manager-agent"]').setValue("codex");
    await wrapper.find('[data-testid="model-manager-config-json"]').setValue('{"reasoningEffort":"high"}');
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    expect(api.post).toHaveBeenCalledWith("/api/model-configs", {
      modelId: "gpt-5.2",
      displayName: "gpt-5.2",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: {
        reasoningEffort: "high",
      },
    });
    expect(wrapper.find('[data-testid="model-manager-status"]').text()).toContain("模型已添加");
    expect(wrapper.emitted("changed")).toHaveLength(1);

    wrapper.unmount();
  });

  it("updates and deletes existing models", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude")]),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue(makeModel("claude-sonnet", "Claude Opus", "anthropic", "claude")),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue({ success: true }),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.find('[title="编辑"]').exists()).toBe(false);
    await wrapper.find(".modelRowMain").trigger("click");
    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("claude-opus");
    await wrapper.find('[data-testid="model-manager-display-name"]').setValue("Claude Opus");
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/claude-sonnet", {
      modelId: "claude-opus",
      displayName: "Claude Opus",
      provider: "anthropic",
      isEnabled: true,
      isDefault: false,
      configJson: null,
    });

    await wrapper.find(".modelIconBtn.danger").trigger("click");
    await settle(wrapper);

    expect(api.delete).toHaveBeenCalledWith("/api/model-configs/claude-sonnet");

    wrapper.unmount();
  });
});
