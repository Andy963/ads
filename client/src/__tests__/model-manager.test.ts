import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import type { ModelConfig } from "../api/types";
import ModelManager from "../components/ModelManager.vue";

function makeModel(
  id: string,
  displayName: string,
  provider: string,
  agent: "codex" | "claude" | "droid",
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
  it("lists every CLI as one row and creates a codex model from that row", async () => {
    const createdModel = makeModel("model-generated", "gpt-5.2", "openai", "codex", "gpt-5.2");
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce([
          makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"),
          makeModel("droid-opus", "Droid Opus", "factory", "droid", "claude-opus-5"),
          {
            id: "local-model",
            displayName: "Local Model",
            provider: "local",
            isEnabled: true,
            isDefault: false,
            configJson: null,
          } satisfies ModelConfig,
        ])
        .mockResolvedValueOnce([makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"), createdModel]),
      post: vi.fn().mockResolvedValue(createdModel),
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

    // One row per CLI, both expanded by default.
    const groups = wrapper.findAll(".cliGroup");
    expect(groups).toHaveLength(3);
    expect(groups[0]!.text()).toContain("Codex CLI");
    expect(groups[1]!.text()).toContain("Claude Code");
    expect(groups[2]!.text()).toContain("Droid CLI");

    // A model only ever renders under its own CLI, and unknown CLIs are dropped.
    expect(groups[0]!.text()).not.toContain("Claude Sonnet");
    expect(groups[1]!.text()).toContain("Claude Sonnet");
    expect(groups[2]!.text()).toContain("Droid Opus");
    expect(wrapper.text()).not.toContain("Local Model");

    // Adding starts from the CLI row, so the dialog never asks which CLI again.
    await wrapper.find('[data-testid="model-manager-add-codex"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-manager-agent"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-manager-dialog"]').text()).toContain("Codex CLI");

    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("gpt-5.2");
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
        allowedAgents: ["codex"],
      },
    });
    expect(wrapper.find('[data-testid="model-manager-status"]').text()).toContain("模型已添加");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);
    expect(wrapper.findAll(".cliGroup")[0]!.text()).toContain("gpt-5.2");

    wrapper.unmount();
  });

  it("filters the manager to the selected CLI", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"),
        makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"),
        makeModel("droid-opus", "Droid Opus", "factory", "droid"),
      ]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any, agent: "claude" },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.findAll(".cliGroup")).toHaveLength(1);
    expect(wrapper.text()).toContain("模型");
    expect(wrapper.text()).toContain("Claude Sonnet");
    expect(wrapper.text()).not.toContain("GPT 5.2");
    expect(wrapper.text()).not.toContain("Droid Opus");
    expect(wrapper.find(".cliRow").exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-manager-cli-claude"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-manager-add-claude"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-manager-add-codex"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("collapses and expands a CLI row without touching the other CLI", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"),
        makeModel("claude-sonnet", "Claude Sonnet", "anthropic", "claude"),
      ]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    expect(wrapper.text()).toContain("GPT 5.2");
    expect(wrapper.text()).toContain("Claude Sonnet");

    await wrapper.find('[data-testid="model-manager-cli-codex"]').trigger("click");
    expect(wrapper.text()).not.toContain("GPT 5.2");
    expect(wrapper.text()).toContain("Claude Sonnet");
    expect(wrapper.find('[data-testid="model-manager-cli-codex"]').attributes("aria-expanded")).toBe("false");
    // The CLI row itself stays visible when collapsed.
    expect(wrapper.text()).toContain("Codex CLI");

    await wrapper.find('[data-testid="model-manager-cli-codex"]').trigger("click");
    expect(wrapper.text()).toContain("GPT 5.2");
    expect(wrapper.find('[data-testid="model-manager-cli-codex"]').attributes("aria-expanded")).toBe("true");

    wrapper.unmount();
  });

  it("edits in a dialog and deletes behind a confirmation", async () => {
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

    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    await wrapper.find('[data-testid="model-manager-edit-claude-sonnet"]').trigger("click");
    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("Claude Code");
    // Config JSON is a plain field in the dialog, not a collapsed section.
    expect(dialog.find("details").exists()).toBe(false);
    expect(dialog.find('[data-testid="model-manager-config-json"]').exists()).toBe(true);

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
      configJson: { allowedAgents: ["claude"] },
    });
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    // Delete button is only visible when the model row is selected.
    expect(wrapper.find('[data-testid="model-manager-delete-claude-sonnet"]').exists()).toBe(false);
    await wrapper.find('[data-testid="model-manager-row-claude-sonnet"]').trigger("click");
    await wrapper.find('[data-testid="model-manager-delete-claude-sonnet"]').trigger("click");
    expect(api.delete).not.toHaveBeenCalled();
    await wrapper.find('[data-testid="model-manager-delete-confirm-claude-sonnet"]').trigger("click");
    await settle(wrapper);

    expect(api.delete).toHaveBeenCalledWith("/api/model-configs/claude-sonnet");

    wrapper.unmount();
  });

  it("surfaces a save failure inside the dialog instead of behind the mask", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockRejectedValue(new Error("model id already exists")),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-add-codex"]').trigger("click");
    await wrapper.find('[data-testid="model-manager-model-id"]').setValue("gpt-5.2");
    await wrapper.find('[data-testid="model-manager-save"]').trigger("submit");
    await settle(wrapper);

    // The dialog stays open so the value is not lost, and the error renders within it.
    const dialog = wrapper.find('[data-testid="model-manager-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.find('[data-testid="model-manager-dialog-error"]').text()).toContain("model id already exists");
    // The page-level banner would be covered by the mask, so it must not be the only signal.
    expect(wrapper.find('[data-testid="model-manager-error"]').exists()).toBe(false);
    expect(wrapper.emitted("changed")).toBeUndefined();

    wrapper.unmount();
  });

  it("never lets the global default be un-defaulted or disabled", async () => {
    const defaultModel = { ...makeModel("gpt-5.2", "GPT 5.2", "openai", "codex"), isDefault: true };
    const api = {
      get: vi.fn().mockResolvedValue([defaultModel]),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    // The row switch cannot disable it — nothing would replace it in the composer dropdown.
    const toggle = wrapper.find('[data-testid="model-manager-toggle-gpt-5.2"]');
    expect(toggle.attributes("disabled")).toBeDefined();
    await toggle.trigger("click");
    await settle(wrapper);
    expect(api.patch).not.toHaveBeenCalled();

    // Neither can the dialog: the server writes isDefault:false verbatim without picking a successor.
    await wrapper.find('[data-testid="model-manager-edit-gpt-5.2"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-default"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="model-manager-enabled"]').attributes("disabled")).toBeDefined();
    await wrapper.find('.btnSecondary').trigger("click");

    // Deleting is already blocked, so the default can only ever be moved to another model (when selected).
    await wrapper.find('[data-testid="model-manager-row-gpt-5.2"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-delete-gpt-5.2"]').attributes("disabled")).toBeDefined();

    wrapper.unmount();
  });

  it("switches default and enabled state from the row without opening the dialog", async () => {
    const codexModel = makeModel("gpt-5.2", "GPT 5.2", "openai", "codex");
    const api = {
      get: vi.fn().mockResolvedValue([codexModel]),
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue(codexModel),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const wrapper = mount(ModelManager, {
      props: { api: api as any },
      global: { stubs: { "el-icon": true } },
    });
    await settle(wrapper);

    await wrapper.find('[data-testid="model-manager-toggle-gpt-5.2"]').trigger("click");
    await settle(wrapper);
    await settle(wrapper);

    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/gpt-5.2", { isEnabled: false });
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    await wrapper.find('[data-testid="model-manager-default-gpt-5.2"]').trigger("click");
    await settle(wrapper);
    await settle(wrapper);

    expect(api.patch).toHaveBeenLastCalledWith("/api/model-configs/gpt-5.2", { isDefault: true });
    expect(wrapper.emitted("changed")).toHaveLength(2);
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);

    wrapper.unmount();
  });
});
