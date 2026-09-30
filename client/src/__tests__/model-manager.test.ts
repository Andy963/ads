import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import ModelManager from "../components/ModelManager.vue";
import ModelServicePicker from "../components/ModelServicePicker.vue";
import RoleSettings from "../components/RoleSettings.vue";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_OUTPUT_TOKENS,
  MAX_MODEL_TOKEN_LIMIT,
  MIN_MODEL_CONTEXT_WINDOW,
  MODEL_CONTEXT_KEYS,
  MODEL_OUTPUT_KEYS,
} from "../../../shared/modelTokenBudget";

function fixture() {
  const providers = [{ id: "p1", name: "Provider One", baseUrl: "https://one.invalid/v1", isEnabled: true, hasCredential: true },
    { id: "p2", name: "Provider Two", baseUrl: "https://two.invalid/v1", isEnabled: true, hasCredential: false }];
  const models = providers.map((p, i) => ({ id: "m" + (i + 1), modelId: "same-name", displayName: p.name + " model", provider: p.name, providerId: p.id, isEnabled: true, isDefault: false }));
  const services = ["conversation", "transcription", "correction"].map(service => ({ service, modelIds: ["m1", "m2"], defaultModelId: "m1" }));
  const profiles = ["acopilot", "developer", "reviewer"].map(role => ({ id: role, role, model_id: "m1", reasoning_effort: "high", system_prompt: role + " prompt" }));
  const api = {
    get: vi.fn(async (url: string) => structuredClone(url === "/api/model-providers" ? providers : url === "/api/model-configs" || url === "/api/models" ? models : url === "/api/model-services" ? services : url === "/api/role-profiles" ? profiles : [])),
    post: vi.fn(async () => ({})), patch: vi.fn(async () => ({})), delete: vi.fn(async () => ({})),
    put: vi.fn(async (url: string, payload: Record<string, unknown>) => {
      const profile = profiles.find(item => url === "/api/role-profiles/" + item.id);
      if (profile) Object.assign(profile, payload);
      return structuredClone(profile ?? payload);
    }),
  };
  return { providers, models, services, profiles, api };
}
beforeEach(() => { config.global.stubs.teleport = true; });
afterEach(() => { delete config.global.stubs.teleport; vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe("provider-first model management", () => {
  it("opens providers first and nests each model under its own provider", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    expect(wrapper.get('[data-testid="provider-settings-tab"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="provider-row-p1"]').find('[data-testid="model-row-m1"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="provider-row-p1"]').find('[data-testid="model-row-m2"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="provider-row-p2"]').find('[data-testid="model-row-m2"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("edits an existing provider with an empty key preserving the stored credential", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="provider-edit-p1"]').trigger("click");
    expect((wrapper.get('[data-testid="provider-base-url"]').element as HTMLInputElement).value).toBe("https://one.invalid/v1");
    expect((wrapper.get('[data-testid="provider-api-key"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-testid="provider-api-key"]').attributes("placeholder")).toBe("Leave blank to keep saved key");
    await wrapper.get('[data-testid="provider-name"]').setValue("Renamed");
    await wrapper.get('[data-testid="provider-form"]').trigger("submit");
    await flushPromises();
    expect(api.patch).toHaveBeenCalledWith("/api/model-providers/p1", expect.objectContaining({ name: "Renamed" }));
    expect(api.patch.mock.calls[0][1]).not.toHaveProperty("apiKey");
    expect(wrapper.find('[data-testid="provider-dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not claim a key is saved for an unconfigured provider", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="provider-edit-p2"]').trigger("click");
    expect(wrapper.get('[data-testid="provider-api-key"]').attributes("placeholder")).toBe("Enter API key");
    wrapper.unmount();
  });

  it("synchronizes only the chosen provider and does not call the legacy discovery endpoint", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="provider-actions-p2"]').trigger("click");
    await wrapper.get('[data-testid="provider-sync-p2"]').trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/model-providers/p2/models/sync", {});
    expect(api.get.mock.calls.some(([url]) => url.includes("upstream"))).toBe(false);
    wrapper.unmount();
  });

  it("creates a model attached to its provider without enabling a service", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="provider-add-model-p2"]').trigger("click");
    await wrapper.get('[data-testid="model-manager-model-id"]').setValue("new-model");
    await wrapper.get('[data-testid="model-form"]').trigger("submit");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith("/api/model-configs", expect.objectContaining({ providerId: "p2", modelId: "new-model", configJson: { reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" } }));
    expect(api.put).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps failed saves visible inside the provider dialog without storing secrets in browser storage", async () => {
    const { api } = fixture();
    api.post.mockRejectedValueOnce(new Error("Provider save failed"));
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="provider-add"]').trigger("click");
    await wrapper.get('[data-testid="provider-name"]').setValue("New");
    await wrapper.get('[data-testid="provider-base-url"]').setValue("https://new.invalid");
    await wrapper.get('[data-testid="provider-api-key"]').setValue("private-test-key");
    await wrapper.get('[data-testid="provider-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.get('[data-testid="provider-dialog"]').text()).toContain("Provider save failed");
    expect(JSON.stringify(localStorage)).not.toContain("private-test-key");
    expect(JSON.stringify(sessionStorage)).not.toContain("private-test-key");
    wrapper.unmount();
  });
});

describe("model token limits", () => {
  async function openEditor(configJson: Record<string, unknown> = {}, create = false) {
    const { api, models } = fixture();
    Object.assign(models[0], { configJson });
    const wrapper = mount(ModelManager, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get(`[data-testid="${create ? "provider-add-model-p1" : "model-row-m1"}"]`).trigger("click");
    return {
      api,
      wrapper,
      input: () => wrapper.get<HTMLInputElement>('[data-testid="model-manager-max-input-tokens"]'),
      output: () => wrapper.get<HTMLInputElement>('[data-testid="model-manager-max-output-tokens"]'),
      json: () => wrapper.get<HTMLTextAreaElement>('[data-testid="model-manager-config-json"]'),
      async save() {
        await wrapper.get('[data-testid="model-manager-save"]').trigger("click");
        await flushPromises();
      },
    };
  }

  it("shows fallback placeholders without claiming runtime limits or persisting defaults on an old model", async () => {
    const original = { custom: { temperature: 0.3, enabled: false }, reasoningEfforts: ["high"] };
    const { api, wrapper, input, output, json, save } = await openEditor(original);
    expect(input().element.value).toBe("");
    expect(output().element.value).toBe("");
    expect(input().attributes("placeholder")).toBe(String(DEFAULT_MODEL_CONTEXT_WINDOW));
    expect(output().attributes("placeholder")).toBe(String(DEFAULT_MODEL_OUTPUT_TOKENS));
    expect(wrapper.get('[data-testid="model-manager-token-defaults"]').text()).toContain("Default context: 262144; default output: 131072");
    expect(wrapper.get('[data-testid="model-manager-token-defaults"]').text()).toContain("Defaults may be overridden by server configuration");
    expect(wrapper.get('[data-testid="model-manager-token-configured"]').text()).toContain("Configured limits: context not set; output not set");
    expect(wrapper.text()).not.toContain("Effective limits");
    expect(JSON.parse(json().element.value)).toEqual(original);
    await save();
    expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/model-configs/m1", expect.objectContaining({ configJson: original }));
    wrapper.unmount();
  });

  it("does not mark an untouched legacy editor dirty or retain another model's token fields", async () => {
    const { wrapper, input, output } = await openEditor({ contextWindow: 8192, maxTokens: 1024 });
    expect(input().element.value).toBe("8192");
    expect(output().element.value).toBe("1024");
    await wrapper.get('[data-testid="model-manager-dialog"] [data-testid="sheet-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="model-manager-dialog"]').exists()).toBe(false);
    await wrapper.get('[data-testid="model-row-m2"]').trigger("click");
    expect(wrapper.get<HTMLInputElement>('[data-testid="model-manager-max-input-tokens"]').element.value).toBe("");
    expect(wrapper.get<HTMLInputElement>('[data-testid="model-manager-max-output-tokens"]').element.value).toBe("");
    wrapper.unmount();
  });

  it.each([
    [MIN_MODEL_CONTEXT_WINDOW, 128],
    [8192, 4096],
    [32769, 16384],
    [1_000_000, DEFAULT_MODEL_OUTPUT_TOKENS],
    [1_048_576, DEFAULT_MODEL_OUTPUT_TOKENS],
    [MAX_MODEL_TOKEN_LIMIT, DEFAULT_MODEL_OUTPUT_TOKENS],
  ])("uses configured context %i and output fallback %i without writing the fallback", async (context, fallback) => {
    const original = { max_input_tokens: context };
    const { api, wrapper, input, output, save } = await openEditor(original);
    expect(input().element.value).toBe(String(context));
    expect(output().element.value).toBe("");
    expect(output().attributes("placeholder")).toBe(String(fallback));
    expect(wrapper.get('[data-testid="model-manager-token-defaults"]').text()).toContain(`default output: ${fallback}`);
    expect(wrapper.get('[data-testid="model-manager-token-configured"]').text()).toContain(`Configured limits: context ${context}; output not set`);
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: original }));
    wrapper.unmount();
  });

  it.each([
    [MIN_MODEL_CONTEXT_WINDOW, 1],
    [8192, 6000],
    [8192, 131072],
    [1_048_576, 1_000_000],
    [MAX_MODEL_TOKEN_LIMIT, MAX_MODEL_TOKEN_LIMIT],
  ])("creates explicit context %i and output %i without clamping, preserving unknown JSON", async (context, limit) => {
    const { api, wrapper, input, output, json, save } = await openEditor({}, true);
    await wrapper.get('[data-testid="model-manager-model-id"]').setValue("budget-model");
    const custom = { reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", providerOption: { nested: [1, true, "value"] } };
    await json().setValue(JSON.stringify(custom));
    await input().setValue(String(context));
    await output().setValue(String(limit));
    const expected = { ...custom, max_input_tokens: context, max_output_tokens: limit };
    expect(JSON.parse(json().element.value)).toEqual(expected);
    expect(wrapper.get('[data-testid="model-manager-token-configured"]').text()).toContain(`Configured limits: context ${context}; output ${limit}`);
    expect(wrapper.get('[data-testid="model-manager-token-configured"]').text()).toContain("Runtime may cap output to fit the context window");
    expect(wrapper.text()).not.toContain("Effective limits");
    await save();
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/model-configs", expect.objectContaining({ modelId: "budget-model", providerId: "p1", configJson: expected }));
    wrapper.unmount();
  });

  it.each(MODEL_CONTEXT_KEYS)("preserves explicit %s and legacy output exactly when saving without token edits", async (key) => {
    const original = { [key]: "8192", maxTokens: "6000", custom: { untouched: true } };
    const { api, wrapper, input, output, json, save } = await openEditor(original);
    expect(input().element.value).toBe("8192");
    expect(output().element.value).toBe("6000");
    expect(JSON.parse(json().element.value)).toEqual(original);
    await wrapper.get('[data-testid="model-manager-display-name"]').setValue("New alias");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ displayName: "New alias", configJson: original }));
    wrapper.unmount();
  });

  it("shows canonical values ahead of aliases without rewriting either on save", async () => {
    const original = { max_input_tokens: "1048576", contextWindow: 8192, max_output_tokens: "1000000", maxTokens: 1024 };
    const { api, wrapper, input, output, save } = await openEditor(original);
    expect(input().element.value).toBe("1048576");
    expect(output().element.value).toBe("1000000");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: original }));
    wrapper.unmount();
  });

  it("reads the first valid alias when a higher-priority value is invalid", async () => {
    const original = { max_input_tokens: 255, contextWindow: 8192, max_output_tokens: "invalid", maxTokens: 1024 };
    const { api, wrapper, input, output, save } = await openEditor(original);
    expect(input().element.value).toBe("8192");
    expect(output().element.value).toBe("1024");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: original }));
    wrapper.unmount();
  });

  it("removes every canonical and legacy token key when clearing dedicated fields", async () => {
    const aliases = Object.fromEntries([...MODEL_CONTEXT_KEYS, ...MODEL_OUTPUT_KEYS].map(key => [key, 8192]));
    const custom = { custom: { value: "keep" }, defaultReasoningEffort: "high" };
    const { api, wrapper, input, output, json, save } = await openEditor({ ...aliases, ...custom });
    await input().setValue("");
    expect(output().element.value).toBe("8192");
    await output().setValue("");
    expect(JSON.parse(json().element.value)).toEqual(custom);
    expect(output().attributes("placeholder")).toBe(String(DEFAULT_MODEL_OUTPUT_TOKENS));
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: custom }));
    wrapper.unmount();
  });

  it("clears output aliases alone and restores the small-window fallback", async () => {
    const { api, wrapper, input, output, json, save } = await openEditor({ context_window: 8192, max_output_tokens: 2048, maxTokens: 1024 });
    await output().setValue("");
    expect(input().element.value).toBe("8192");
    expect(output().attributes("placeholder")).toBe("4096");
    expect(JSON.parse(json().element.value)).toEqual({ context_window: 8192 });
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: { context_window: 8192 } }));
    wrapper.unmount();
  });

  it("lets later JSON edits replace dedicated drafts and preserves the edited keys verbatim", async () => {
    const { api, wrapper, input, output, json, save } = await openEditor({ max_input_tokens: 8192, max_output_tokens: 4096 });
    await input().setValue("1048576");
    await output().setValue("131072");
    const edited = { context_window: "16384", maxTokens: "6000", custom: ["new"] };
    await json().setValue(JSON.stringify(edited));
    expect(input().element.value).toBe("16384");
    expect(output().element.value).toBe("6000");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: edited }));
    wrapper.unmount();
  });

  it("does not resurrect token fields removed in JSON", async () => {
    const { api, wrapper, input, output, json, save } = await openEditor({ contextWindow: 8192, maxTokens: 4096 });
    await json().setValue('{"custom":true}');
    expect(input().element.value).toBe("");
    expect(output().element.value).toBe("");
    expect(output().attributes("placeholder")).toBe(String(DEFAULT_MODEL_OUTPUT_TOKENS));
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: { custom: true } }));
    wrapper.unmount();
  });

  it("edits and clears aliases added through JSON while preserving its unrelated changes", async () => {
    const { api, wrapper, input, output, json, save } = await openEditor();
    await json().setValue('{"maxContextTokens":8192,"maxTokens":1024,"custom":{"edited":true}}');
    await input().setValue("1048576");
    expect(JSON.parse(json().element.value)).toEqual({ max_input_tokens: 1048576, maxTokens: 1024, custom: { edited: true } });
    await output().setValue("");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: { max_input_tokens: 1048576, custom: { edited: true } } }));
    wrapper.unmount();
  });

  it.each(["{", "[]", "null", '"text"'])("blocks token editing and saving invalid JSON %s until it is repaired", async (invalid) => {
    const { api, wrapper, input, output, json, save } = await openEditor({ max_input_tokens: 8192 });
    await json().setValue(invalid);
    expect(input().element.disabled).toBe(true);
    expect(output().element.disabled).toBe(true);
    await save();
    expect(api.patch).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="model-manager-dialog"] [role="alert"]').exists()).toBe(true);
    await json().setValue('{"max_input_tokens":16384,"custom":"repaired"}');
    expect(input().element.disabled).toBe(false);
    expect(input().element.value).toBe("16384");
    await output().setValue("2048");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: { max_input_tokens: 16384, max_output_tokens: 2048, custom: "repaired" } }));
    wrapper.unmount();
  });

  it.each([
    ["input", "255", "max_input_tokens"],
    ["input", "8192.5", "max_input_tokens"],
    ["input", "-8192", "max_input_tokens"],
    ["input", "0", "max_input_tokens"],
    ["input", String(MAX_MODEL_TOKEN_LIMIT + 1), "max_input_tokens"],
    ["input", "invalid", "max_input_tokens"],
    ["output", "0", "max_output_tokens"],
    ["output", "-1", "max_output_tokens"],
    ["output", "1.5", "max_output_tokens"],
    ["output", String(MAX_MODEL_TOKEN_LIMIT + 1), "max_output_tokens"],
    ["output", "NaN", "max_output_tokens"],
    ["output", "Infinity", "max_output_tokens"],
    ["output", "1e", "max_output_tokens"],
  ])("rejects invalid %s value %s without saving or clearing the existing config", async (field, value, key) => {
    const original = { contextWindow: 8192, maxTokens: 4096, custom: "keep" };
    const { api, wrapper, input, output, json, save } = await openEditor(original);
    const target = field === "input" ? input : output;
    await target().setValue(value);
    expect(target().element.value).toBe(value);
    expect(target().attributes("aria-invalid")).toBe("true");
    expect(JSON.parse(json().element.value)).toEqual(original);
    await save();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="model-manager-dialog"] [role="alert"]').text()).toContain(`${key} must be an integer`);
    await target().setValue("2048");
    await save();
    expect(api.patch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("keeps an invalid draft when editing the other field, then lets JSON explicitly replace it", async () => {
    const { api, wrapper, input, output, json, save } = await openEditor();
    await input().setValue("invalid");
    await output().setValue("2048");
    expect(input().element.value).toBe("invalid");
    await save();
    expect(api.patch).not.toHaveBeenCalled();
    await json().setValue('{"max_input_tokens":8192,"max_output_tokens":2048}');
    expect(input().element.value).toBe("8192");
    await save();
    expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: { max_input_tokens: 8192, max_output_tokens: 2048 } }));
    wrapper.unmount();
  });

  it("keeps focus while typing token limits in the real teleported dialog", async () => {
    const { api } = fixture();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const wrapper = mount(ModelManager, { props: { api: api as any }, attachTo: host, global: { stubs: { teleport: false } } });
    try {
      await flushPromises();
      await wrapper.get('[data-testid="model-row-m1"]').trigger("click");
      await flushPromises();
      const input = document.querySelector<HTMLInputElement>('[data-testid="model-manager-max-input-tokens"]')!;
      input.focus();
      for (const value of ["8", "81", "819", "8192"]) {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flushPromises();
        expect(document.querySelector('[data-testid="model-manager-max-input-tokens"]')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe(value);
      }
      document.querySelector<HTMLButtonElement>('[data-testid="model-manager-save"]')!.click();
      await flushPromises();
      expect(api.patch).toHaveBeenCalledWith("/api/model-configs/m1", expect.objectContaining({ configJson: expect.objectContaining({ max_input_tokens: 8192 }) }));
    } finally {
      wrapper.unmount();
      host.remove();
    }
  });
});

describe("service selection", () => {
  it("removes multiple unavailable references in one valid update", async () => {
    const { api, providers } = fixture();
    providers.forEach(provider => { provider.isEnabled = false; });
    const wrapper = mount(ModelServicePicker, { props: { api: api as any, service: "transcription" } });
    await flushPromises();
    await wrapper.get('[data-testid="service-remove-unavailable"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/api/model-services/transcription", { modelIds: [], defaultModelId: null });
    wrapper.unmount();
  });

  it("restores an enabled switch when automatic persistence fails", async () => {
    const { api } = fixture();
    api.put.mockRejectedValueOnce(new Error("Connection lost"));
    const wrapper = mount(ModelServicePicker, { props: { api: api as any, service: "transcription" } });
    await flushPromises();
    await wrapper.get('[data-testid="service-enable-m1"]').setValue(false);
    await flushPromises();
    expect((wrapper.get('[data-testid="service-enable-m1"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toContain("Connection lost");
    expect(wrapper.get('[data-testid="service-default-open"]').text()).toContain("Provider One model");
    wrapper.unmount();
  });

  it.each(["conversation", "transcription", "correction"] as const)("saves multiple enabled %s candidates and exactly one default", async (service) => {
    const { api } = fixture();
    const wrapper = mount(ModelServicePicker, { props: { api: api as any, service } });
    await flushPromises();
    await wrapper.get('[data-testid="service-default-open"]').trigger("click");
    await wrapper.get('[data-testid="service-default-m2"]').setValue(true);
    await flushPromises();
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/api/model-services/" + service, { modelIds: ["m1", "m2"], defaultModelId: "m2" });
    expect(wrapper.find('[data-testid="service-default-picker"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="service-default-open"]').text()).toContain("Provider Two model");
    expect(api.post).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("clears the default only when the service has no enabled models", async () => {
    const { api } = fixture();
    const wrapper = mount(ModelServicePicker, { props: { api: api as any, service: "transcription" } });
    await flushPromises();
    await wrapper.get('[data-testid="service-enable-m1"]').setValue(false);
    await flushPromises();
    expect(wrapper.get('[data-testid="service-default-open"]').text()).toContain("Provider Two model");
    await wrapper.get('[data-testid="service-enable-m2"]').setValue(false);
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith("/api/model-services/transcription", { modelIds: [], defaultModelId: null });
    wrapper.unmount();
  });
});

describe("single-copy role settings", () => {
  it("loads only role profiles and enabled conversation models, with no history controls", async () => {
    const { api } = fixture();
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    expect(api.get.mock.calls.map(([url]) => url).sort()).toEqual(["/api/models", "/api/role-profiles"]);
    expect(wrapper.find('[data-testid="lane-prompt-version-select"]').exists()).toBe(false);
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    expect(wrapper.get('[data-testid="role-model-m1"]').text()).toContain("Provider One");
    expect(wrapper.get('[data-testid="role-model-m2"]').text()).toContain("Provider Two");
    wrapper.unmount();
  });

  it("preserves instruction drafts across roles and model or effort saves", async () => {
    const { api } = fixture();
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="lane-prompt-editor"]').setValue("Edited prompt");
    await wrapper.get('[data-testid="lane-prompt-lane-actions"]').trigger("click");
    await wrapper.get('[data-testid="lane-prompt-lane-acopilot"]').trigger("click");
    expect((wrapper.get('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Edited prompt");
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    await wrapper.get('[data-testid="role-model-m2"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith("/api/role-profiles/acopilot", { model_id: "m2" });
    expect((wrapper.get('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Edited prompt");
    await wrapper.get('[data-testid="role-effort-select"]').trigger("click");
    await wrapper.get('[data-testid="role-effort-medium"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith("/api/role-profiles/acopilot", { reasoning_effort: "medium" });
    await wrapper.get('[data-testid="lane-prompt-save"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith("/api/role-profiles/acopilot", { system_prompt: "Edited prompt" });
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.post).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("persists a legacy name as a catalog ID even when reselecting the displayed model", async () => {
    const { api, profiles, models } = fixture();
    models[0].modelId = "legacy-upstream";
    profiles[0].model_id = "legacy-upstream";
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    expect(wrapper.get('[data-testid="role-model-m1"]').attributes("aria-pressed")).toBe("true");
    await wrapper.get('[data-testid="role-model-m1"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/api/role-profiles/acopilot", { model_id: "m1" });
    expect(profiles[0].model_id).toBe("m1");
    expect(wrapper.find('[data-testid="role-selection-sheet"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("saves model selections independently of an empty instruction draft", async () => {
    const { api, profiles } = fixture();
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="lane-prompt-editor"]').setValue("");
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    await wrapper.get('[data-testid="role-model-m2"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/api/role-profiles/acopilot", { model_id: "m2" });
    expect(profiles[0].system_prompt).toBe("acopilot prompt");
    expect((wrapper.get('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("");
    await wrapper.get('[data-testid="lane-prompt-reset"]').trigger("click");
    expect((wrapper.get('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("acopilot prompt");
    expect(wrapper.get('[data-testid="role-model-select"]').text()).toContain("Provider Two");
    wrapper.unmount();
  });

  it("retains the previous model and draft on failure and retries without duplication", async () => {
    const { api } = fixture();
    api.put.mockRejectedValueOnce(new Error("Model unavailable"));
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="lane-prompt-editor"]').setValue("Draft");
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    await wrapper.get('[data-testid="role-model-m2"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="role-selection-sheet"]').text()).toContain("Model unavailable");
    expect(wrapper.get('[data-testid="role-model-m1"]').attributes("aria-pressed")).toBe("true");
    expect((wrapper.get('[data-testid="lane-prompt-editor"]').element as HTMLTextAreaElement).value).toBe("Draft");
    await wrapper.get('[data-testid="role-model-m2"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="role-selection-sheet"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("saves instructions with an unavailable model and keeps model controls below the editor", async () => {
    const { api, profiles } = fixture();
    profiles[0].model_id = "removed";
    const wrapper = mount(RoleSettings, { props: { api: api as any } });
    await flushPromises();
    const editor = wrapper.get('[data-testid="lane-prompt-editor"]');
    expect(editor.element.compareDocumentPosition(wrapper.get('[data-testid="role-model-select"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await editor.setValue("New instructions");
    await wrapper.get('[data-testid="lane-prompt-save"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledExactlyOnceWith("/api/role-profiles/acopilot", { system_prompt: "New instructions" });
    wrapper.unmount();
  });
});
