import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, flushPromises, mount } from "@vue/test-utils";
import VoiceSettings from "../components/VoiceSettings.vue";
import ModelManager from "../components/ModelManager.vue";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../../shared/voice";

function settings() {
  return { configured: true, hasApiKey: true, correctionHasApiKey: true, source: "saved", config: {
    enabled: true, transcription: { provider: "Provider", providerId: "p", baseUrl: "https://api.invalid/v1", model: "asr", language: "zh", prompt: "", timeoutMs: 120000 },
    correction: { enabled: false, provider: "Provider", providerId: "p", baseUrl: "https://api.invalid/v1", model: "correct", systemPrompt: DEFAULT_CORRECTION_SYSTEM_PROMPT, reasoningEffort: "high", timeoutMs: 15000 }, totalTimeoutMs: 135000,
  } };
}
function apiFixture() {
  return {
    get: vi.fn(async (url: string) => url === "/api/voice/settings" ? settings() : []),
    put: vi.fn(async (url: string, body: { config: any }) => ({ ...settings(), config: url === "/api/voice/correction"
      ? { ...settings().config, correction: body.config } : { ...settings().config, ...body.config } })),
    post: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  };
}
beforeEach(() => { config.global.stubs.teleport = true; });
afterEach(() => { delete config.global.stubs.teleport; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("voice services", () => {
  it.each(["transcription", "correction"] as const)("uses the %s service picker without duplicate connection forms", async section => {
    const api = apiFixture();
    const wrapper = mount(VoiceSettings, { props: { api: api as any, section } });
    await flushPromises();
    expect(wrapper.find('[data-testid="service-models-' + section + '"]').exists()).toBe(true);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.find('input[type="url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="voice-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="correction-model"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([true, false])("keeps providers, conversation, transcription and correction panels exclusive with tabs=%s", async showTabs => {
    const wrapper = mount(ModelManager, { props: { api: apiFixture() as any, showTabs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="settings-providers-panel"]').exists()).toBe(true);
    for (const [tab, panel] of [["voice", "voice-settings"], ["correction", "correction-settings"], ["conversation", "service-models-conversation"]]) {
      await wrapper.get('[data-testid="' + tab + '-settings-tab"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="' + panel + '"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="settings-providers-panel"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
    }
    wrapper.unmount();
  });

  it("saves correction options independently without creating a model or modifying transcription", async () => {
    const api = apiFixture();
    const wrapper = mount(VoiceSettings, { props: { api: api as any, section: "correction" } });
    await flushPromises();
    await wrapper.get('[data-testid="voice-options-open"]').trigger("click");
    await wrapper.get('[data-testid="correction-system-prompt"]').setValue("Fix spelling only.");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith("/api/voice/correction", { config: { ...settings().config.correction, systemPrompt: "Fix spelling only." } });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("recovers corrupt options only after an explicit reset", async () => {
    const api = apiFixture();
    api.get.mockImplementation(async url => url === "/api/voice/settings" ? { ...settings(), recoveryRequired: true } : []);
    const wrapper = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="voice-options-open"]').trigger("click");
    await wrapper.get("form").trigger("submit");
    expect(api.put).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="voice-reset-options"]').trigger("click");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith("/api/voice/settings", expect.objectContaining({ resetOptions: true }));
    wrapper.unmount();
  });

  it("does not save a dirty draft when testing and cancels the request on unmount", async () => {
    const api = apiFixture();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => { signal = init.signal; return new Promise(() => {}); }));
    const wrapper = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="voice-test-open"]').trigger("click");
    const file = new File(["audio"], "test.webm", { type: "audio/webm" });
    Object.defineProperty(wrapper.get('[data-testid="voice-sample"]').element, "files", { value: [file] });
    await wrapper.get('[data-testid="voice-sample"]').trigger("change");
    await wrapper.get('[data-testid="voice-test"]').trigger("click");
    expect(api.put).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
