import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

class FakeMediaRecorder {
  static latest: FakeMediaRecorder | null = null;

  static isTypeSupported(): boolean {
    return true;
  }

  public mimeType = "audio/webm";
  public ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType || this.mimeType;
    FakeMediaRecorder.latest = this;
  }

  start(): void {
    // no-op
  }

  stop(): void {
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await nextTick();
}

function installReactiveAudioMocks() {
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId++;
    frameCallbacks.set(frameId, callback);
    return frameId;
  });
  const cancelAnimationFrame = vi.fn((frameId: number) => {
    frameCallbacks.delete(frameId);
  });
  const analyser = {
    fftSize: 256,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(220)),
    disconnect: vi.fn(),
  };
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const close = vi.fn(() => Promise.resolve());

  class FakeAudioContext {
    createAnalyser(): typeof analyser {
      return analyser;
    }

    createMediaStreamSource(): typeof source {
      return source;
    }

    resume(): Promise<void> {
      return Promise.resolve();
    }

    close(): Promise<void> {
      return close();
    }
  }

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  const runNextFrame = (): void => {
    const entry = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    frameCallbacks.delete(entry[0]);
    entry[1](0);
  };

  return {
    analyser,
    source,
    close,
    requestAnimationFrame,
    cancelAnimationFrame,
    runNextFrame,
  };
}

describe("MainChat composer voice input locking", () => {
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
  });

  afterEach(() => {
    FakeMediaRecorder.latest = null;
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder = originalMediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("preserves a completed transcription when the composer locks while the request is pending", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as typeof fetch;

    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    const mic = wrapper.find("button.micIcon");
    await mic.trigger("click");
    await nextTick();
    await mic.trigger("click");
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ inputLocked: true });
    resolveFetch?.({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, text: "Preserved voice text" }),
    });
    await settle();

    const textarea = wrapper.find("textarea");
    expect(textarea.attributes("disabled")).toBeDefined();
    const draftUpdates = wrapper.emitted("update:draft") ?? [];
    expect(draftUpdates.some((args) => String(args[0] ?? "").includes("Preserved voice text"))).toBe(true);
    expect(wrapper.find(".voiceToast.ok").text()).toContain("已追加语音文本");
    wrapper.unmount();
  });

  it("keeps the stop control available when the composer locks during recording", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, text: "Stopped recording text" }),
    }) as typeof fetch;

    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    const mic = wrapper.find("button.micIcon");
    await mic.trigger("click");
    await nextTick();
    expect(wrapper.find(".voiceIndicator.recording").exists()).toBe(true);

    await wrapper.setProps({ inputLocked: true });
    expect(mic.attributes("disabled")).toBeUndefined();

    await mic.trigger("click");
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".voiceIndicator.recording").exists()).toBe(false);
    const draftUpdates = wrapper.emitted("update:draft") ?? [];
    expect(draftUpdates.some((args) => String(args[0] ?? "").includes("Stopped recording text"))).toBe(true);
    wrapper.unmount();
  });

  it("renders ChatGPT-style voice dictation bar during recording and supports cancel", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "" }) });
    globalThis.fetch = fetchMock;
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    expect(wrapper.find('[data-testid="voice-cancel-btn"]').exists()).toBe(false);
    expect(wrapper.find(".composerMainRow--recording").exists()).toBe(false);

    // Start recording
    await wrapper.find("button.micIcon").trigger("click");
    await nextTick();

    expect(wrapper.find(".composerMainRow--recording").exists()).toBe(true);
    expect(wrapper.find('[data-testid="voice-cancel-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="voice-stop-btn"]').exists()).toBe(true);
    expect(wrapper.find(".voiceDotTrail").exists()).toBe(true);
    expect(wrapper.find(".voiceEqualizerBars").exists()).toBe(true);
    expect(wrapper.find(".voiceEqualizerBars--reactive").exists()).toBe(false);
    expect(wrapper.find(".eqBar").attributes("style")).toContain("animation-delay");
    expect(wrapper.find(".sendIcon--activeVoice").exists()).toBe(true);

    // Click cancel button
    await wrapper.find('[data-testid="voice-cancel-btn"]').trigger("click");
    await settle();

    expect(wrapper.find(".composerMainRow--recording").exists()).toBe(false);
    expect(wrapper.find('[data-testid="voice-cancel-btn"]').exists()).toBe(false);
    // Audio should not have been transcribed
    expect(fetchMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("drives bounded waveform levels from analyser amplitude and releases audio on cancel", async () => {
    const audio = installReactiveAudioMocks();
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });

    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    await wrapper.find("button.micIcon").trigger("click");
    await settle();

    expect(wrapper.find(".voiceEqualizerBars--reactive").exists()).toBe(true);
    expect(audio.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(audio.source.connect).toHaveBeenCalledWith(audio.analyser);

    audio.runNextFrame();
    await nextTick();
    const loudStyle = wrapper.find(".eqBar").attributes("style") ?? "";
    const loudScale = Number(loudStyle.match(/scaleY\(([\d.]+)\)/)?.[1] ?? 0);
    expect(loudScale).toBeGreaterThan(0.12);

    audio.analyser.getByteTimeDomainData.mockImplementation((samples: Uint8Array) => samples.fill(128));
    for (let index = 0; index < 12; index += 1) {
      audio.runNextFrame();
    }
    await nextTick();
    const quietStyle = wrapper.find(".eqBar").attributes("style") ?? "";
    const quietScale = Number(quietStyle.match(/scaleY\(([\d.]+)\)/)?.[1] ?? 1);
    expect(quietScale).toBeLessThan(loudScale);
    expect(quietScale).toBeGreaterThanOrEqual(0.12);

    await wrapper.find('[data-testid="voice-cancel-btn"]').trigger("click");
    await settle();

    expect(audio.cancelAnimationFrame).toHaveBeenCalled();
    expect(audio.source.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("releases analyser and media resources when unmounted during recording", async () => {
    const audio = installReactiveAudioMocks();
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    await wrapper.find("button.micIcon").trigger("click");
    await settle();
    wrapper.unmount();
    await settle();

    expect(audio.cancelAnimationFrame).toHaveBeenCalled();
    expect(audio.source.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("releases analyser and media resources when recording stops", async () => {
    const audio = installReactiveAudioMocks();
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "" }),
    }) as typeof fetch;
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    await wrapper.find("button.micIcon").trigger("click");
    await settle();
    await wrapper.find('[data-testid="voice-stop-btn"]').trigger("click");
    await settle();

    expect(audio.cancelAnimationFrame).toHaveBeenCalled();
    expect(audio.source.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("releases analyser and media resources after a recorder error", async () => {
    const audio = installReactiveAudioMocks();
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: { stubs: { MainChatPendingImageViewer: true } },
    });

    await wrapper.find("button.micIcon").trigger("click");
    await settle();
    FakeMediaRecorder.latest?.onerror?.();
    await settle();

    expect(wrapper.find(".composerMainRow--recording").exists()).toBe(false);
    expect(audio.cancelAnimationFrame).toHaveBeenCalled();
    expect(audio.source.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
