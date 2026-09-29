import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import VoiceSettings from "../components/VoiceSettings.vue";
import ModelManager from "../components/ModelManager.vue";
import type { VoiceSettingsResponse } from "../../../shared/voice";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../../shared/voice";

function settings(): VoiceSettingsResponse {
  return {
    configured: true, hasApiKey: true, source: "saved",
    config: { enabled: true, transcription: { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3", language: "zh", prompt: "", timeoutMs: 120000 }, correction: { enabled: false, provider: "openai", baseUrl: "", model: "", systemPrompt: DEFAULT_CORRECTION_SYSTEM_PROMPT, reasoningEffort: "high", timeoutMs: 15000 }, totalTimeoutMs: 135000 },
    correctionHasApiKey: false,
  };
}
function makeApi() {
  return {
    get: vi.fn(async (url: string) => url === "/api/voice/settings" ? settings() : []),
    put: vi.fn(async (url: string, body: { config: any }) => ({ ...settings(), config: url === "/api/voice/correction"
      ? { ...settings().config, correction: JSON.parse(JSON.stringify(body.config)) }
      : { ...settings().config, ...JSON.parse(JSON.stringify(body.config)) } })),
    post: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Voice Input settings", () => {
  it.each([true, false])("keeps voice and role panels exclusive with showTabs=%s", async (showTabs) => {
    const wrapper = mount(ModelManager, {
      props: { api: makeApi() as any, initialTab: "models", showTabs, showHeader: false },
      global: { stubs: { "el-icon": true } },
    });
    try {
      await flushPromises();
      expect(wrapper.find('[data-testid="settings-models-panel"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
      await wrapper.get('[data-testid="voice-settings-tab"]').trigger("click");
      await flushPromises();
      expect(wrapper.findComponent(VoiceSettings).exists()).toBe(true);
      expect(wrapper.find('[data-testid="settings-models-panel"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
      await wrapper.get('[data-testid="correction-settings-tab"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="correction-settings"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="voice-settings"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
      await wrapper.get('[data-testid="correction-api-key"]').setValue("unsaved-correction-key");
      await wrapper.get('[data-testid="voice-settings-tab"]').trigger("click");
      await wrapper.get('[data-testid="correction-settings-tab"]').trigger("click");
      await flushPromises();
      expect((wrapper.get('[data-testid="correction-api-key"]').element as HTMLInputElement).value).toBe("");
      expect(JSON.stringify(localStorage)).not.toContain("unsaved-correction-key");
      expect(JSON.stringify(sessionStorage)).not.toContain("unsaved-correction-key");
      if (showTabs) {
        await wrapper.get('[data-testid="settings-tab-prompts"]').trigger("click");
        expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(true);
        expect(wrapper.findComponent(VoiceSettings).exists()).toBe(false);
        await wrapper.get('[data-testid="settings-tab-models"]').trigger("click");
        expect(wrapper.findComponent(VoiceSettings).exists()).toBe(true);
        expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
      }
      await wrapper.findAll("button").find((button) => button.text() === "对话模型")!.trigger("click");
      expect(wrapper.find('[data-testid="settings-models-panel"]').exists()).toBe(true);
      expect(wrapper.findComponent(VoiceSettings).exists()).toBe(false);
      expect(wrapper.find('[data-testid="lane-prompt-panel"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it("offers explicit-key recovery only for a corrupt saved configuration, not general load failure", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({ ...settings(), configured: false, hasApiKey: false, recoveryRequired: true });
    const wrapper = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    expect(wrapper.text()).toContain("已保存的配置损坏");
    await wrapper.get("form").trigger("submit");
    expect(api.put).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="voice-api-key"]').setValue("repair-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledOnce();
    wrapper.unmount();
    api.get.mockRejectedValue(new Error("network failure"));
    const unavailable = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    expect(unavailable.find("form").exists()).toBe(false);
    unavailable.unmount();
  });

  it("edits correction directly without selecting, creating or changing a conversation model", async () => {
    const api = makeApi();
    const wrapper = mount(VoiceSettings, { props: { api: api as any, section: "correction" } });
    await flushPromises();
    expect(wrapper.find('[data-testid="voice-base-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="voice-correction-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="voice-test"]').exists()).toBe(false);
    await wrapper.get('[data-testid="voice-correction-enabled"]').setValue(true);
    await wrapper.get('[data-testid="correction-base-url"]').setValue("https://correction.invalid/v1");
    await wrapper.get('[data-testid="correction-api-key"]').setValue("own-key");
    await wrapper.get('[data-testid="correction-model"]').setValue("my-model");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith("/api/voice/correction", {
      apiKey: "own-key",
      config: { enabled: true, provider: "openai", baseUrl: "https://correction.invalid/v1", model: "my-model", systemPrompt: DEFAULT_CORRECTION_SYSTEM_PROMPT, reasoningEffort: "high", timeoutMs: 15000 },
    });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.get.mock.calls.every(([url]) => url === "/api/voice/settings")).toBe(true);
    expect((wrapper.get('[data-testid="correction-api-key"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).toContain("文本纠错设置已保存");
    wrapper.unmount();
  });

  it("is reachable with mobile outer tabs hidden and clears keys when leaving the section", async () => {
    const api = makeApi();
    const wrapper = mount(ModelManager, { props: { api: api as any, showTabs: false, showHeader: false }, global: { stubs: { "el-icon": true } } });
    await flushPromises();
    expect(wrapper.find('[data-testid="settings-tabs"]').exists()).toBe(false);
    await wrapper.get('[data-testid="voice-settings-tab"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="voice-api-key"]').setValue("temporary-key");
    const conversation = wrapper.findAll("button").find((button) => button.text() === "对话模型")!;
    await conversation.trigger("click");
    await wrapper.get('[data-testid="voice-settings-tab"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-testid="voice-api-key"]').element as HTMLInputElement).value).toBe("");
    expect(JSON.stringify(localStorage)).not.toContain("temporary-key");
    expect(JSON.stringify(sessionStorage)).not.toContain("temporary-key");
    wrapper.unmount();
  });
  it("saves only ASR settings and clears its secret without changing correction", async () => {
    const api = makeApi();
    const wrapper = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="voice-api-key"]').setValue("replacement-key");
    expect(wrapper.find('[data-testid="correction-base-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="correction-system-prompt"]').exists()).toBe(false);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledOnce();
    expect(api.put.mock.calls[0][0]).toBe("/api/voice/settings");
    expect(api.put.mock.calls[0][1]).toMatchObject({ apiKey: "replacement-key", config: { transcription: { provider: "groq" } } });
    expect(api.put.mock.calls[0][1].config).not.toHaveProperty("correction");
    expect((wrapper.get('[data-testid="voice-api-key"]').element as HTMLInputElement).value).toBe("");
    expect(api.post).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("语音转写设置已保存");
    wrapper.unmount();
  });
  it("loads and saves the correction prompt while resetting only the draft", async () => {
    const api = makeApi();
    const value = settings();
    value.config.correction.systemPrompt = "Preserve names and punctuation.";
    api.get.mockResolvedValue(value);
    const wrapper = mount(VoiceSettings, { props: { api: api as any, section: "correction" } });
    await flushPromises();
    const prompt = wrapper.get('[data-testid="correction-system-prompt"]');
    expect((prompt.element as HTMLTextAreaElement).value).toBe(value.config.correction.systemPrompt);
    await wrapper.get('[data-testid="correction-reset-prompt"]').trigger("click");
    expect((prompt.element as HTMLTextAreaElement).value).toBe(DEFAULT_CORRECTION_SYSTEM_PROMPT);
    expect(api.put).not.toHaveBeenCalled();
    const customPrompt = "Fix only spelling.\nKeep the original wording.";
    await prompt.setValue(customPrompt);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith("/api/voice/correction", { config: { ...value.config.correction, systemPrompt: customPrompt } });
    expect((prompt.element as HTMLTextAreaElement).value).toBe(customPrompt);
    wrapper.unmount();
  });
  it("keeps the visually hidden section legend in the accessibility tree", async () => {
    const api = makeApi();
    const correction = mount(VoiceSettings, { props: { api: api as any, section: "correction" } });
    await flushPromises();
    expect(correction.get("form fieldset legend").text()).toBe("文本纠错");
    expect(correction.get('[data-testid="correction-settings"]').attributes("aria-label")).toBe("文本纠错");
    correction.unmount();
    const voice = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    expect(voice.get("form fieldset legend").text()).toBe("语音转写");
    expect(voice.get('[data-testid="voice-settings"]').attributes("aria-label")).toBe("语音转写");
    voice.unmount();
  });

  it("stretches the model sub-tab row to full width without touching the outer tabs", async () => {
    const wrapper = mount(ModelManager, {
      props: { api: makeApi() as any, initialTab: "models", showTabs: true, showHeader: false },
      global: { stubs: { "el-icon": true } },
    });
    try {
      await flushPromises();
      expect(wrapper.get('nav[aria-label="模型配置分区"]').classes()).toContain("settingsTabsSub");
      expect(wrapper.get('[data-testid="settings-tabs"]').classes()).not.toContain("settingsTabsSub");
    } finally {
      wrapper.unmount();
    }
  });

  it("renders exactly two hint paragraphs per panel with one shared key-change rule", async () => {
    const api = makeApi();
    const keyRule = "更换服务地址时必须填写匹配的新密钥；纠错不读取对话模型、角色指令或聊天记录。";
    const correction = mount(VoiceSettings, { props: { api: api as any, section: "correction" } });
    await flushPromises();
    expect(correction.findAll("p").map((p) => p.text())).toEqual([
      "设置随账户同步，密钥仅在服务端加密保存。",
      keyRule,
    ]);
    expect(correction.text()).not.toContain("最多 8000 字符");
    correction.unmount();
    const voice = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    const voiceHints = voice.findAll("p").filter((p) => {
      const fieldset = p.element.closest("fieldset");
      return !fieldset || Boolean(fieldset.closest("form"));
    });
    expect(voiceHints.map((p) => p.text())).toEqual([
      "设置随账户同步，密钥仅在服务端加密保存。",
      keyRule,
    ]);
    expect(voice.text()).toContain("仅使用已保存的设置，不保存当前修改");
    expect(voice.text()).toContain("发送到转写服务");
    voice.unmount();
  });

  it("tests saved settings only without implicitly saving a dirty draft and aborts when closed", async () => {
    const api = makeApi();
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(VoiceSettings, { props: { api: api as any } });
    await flushPromises();
    await wrapper.get('[data-testid="voice-base-url"]').setValue("https://unsaved.invalid/v1");
    const input = wrapper.get('[data-testid="voice-sample"]');
    const file = new File(["audio"], "recording.m4a", { type: "audio/mp4" });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await wrapper.get('[data-testid="voice-test"]').trigger("click");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/audio/transcriptions");
    expect(fetchMock.mock.calls[0][1].body).toBe(file);
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    wrapper.unmount();
    expect(signal.aborted).toBe(true);
    pending.resolve({ ok: true, json: async () => ({ ok: true, text: "stale" }) } as Response);
    await flushPromises();
  });
});
