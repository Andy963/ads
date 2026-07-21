import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  public mimeType = "audio/webm";
  public ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType || this.mimeType;
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
});
