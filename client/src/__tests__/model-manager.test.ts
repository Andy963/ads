import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import ModelManager from "../components/ModelManager.vue";
import ModelServicePicker from "../components/ModelServicePicker.vue";
import RoleSettings from "../components/RoleSettings.vue";

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
