import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import TaskCreateForm from "../components/TaskCreateForm.vue";
import type { ModelConfig } from "../api/types";

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
    const blob = new Blob(["a"], { type: this.mimeType || "audio/webm" });
    this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TaskCreateForm voice input", () => {
  const models: ModelConfig[] = [{ id: "auto", displayName: "Auto", provider: "", isEnabled: true, isDefault: true }];

  const originalMediaRecorder = (globalThis as any).MediaRecorder;
  const originalMediaDevices = (navigator as any).mediaDevices;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/");

    (globalThis as any).MediaRecorder = FakeMediaRecorder;
    (navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    };
  });

  afterEach(() => {
    localStorage.clear();
    globalThis.fetch = originalFetch;
    (globalThis as any).MediaRecorder = originalMediaRecorder;
    (navigator as any).mediaDevices = originalMediaDevices;
  });

  it("renders voice UI by default", () => {
    const wrapper = mount(TaskCreateForm, { props: { models, workspaceRoot: "" } });
    expect(wrapper.find("button.micIcon").exists()).toBe(true);
    wrapper.unmount();
  });

  it("records and transcribes into the prompt", async () => {
    localStorage.setItem("ADS_WEB_TASK_VOICE_INPUT", "1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, text: "Hello from voice" }),
    });
    globalThis.fetch = fetchMock as any;

    const wrapper = mount(TaskCreateForm, { props: { models, workspaceRoot: "" } });
    const mic = wrapper.find("button.micIcon");
    expect(mic.exists()).toBe(true);

    await mic.trigger("click");
    await nextTick();
    expect(wrapper.find(".voiceIndicator.recording").exists()).toBe(true);

    await mic.trigger("click");
    await flush();
    await nextTick();

    expect(fetchMock).toHaveBeenCalled();
    const textarea = wrapper.find("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toContain("Hello from voice");
    wrapper.unmount();
  });

  it("cancel discards recording without transcription", async () => {
    localStorage.setItem("ADS_WEB_TASK_VOICE_INPUT", "1");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;

    const wrapper = mount(TaskCreateForm, { props: { models, workspaceRoot: "" } });
    const mic = wrapper.find("button.micIcon");
    await mic.trigger("click");
    await nextTick();

    const cancel = wrapper.find("button.voiceCancelBtn");
    expect(cancel.exists()).toBe(true);
    await cancel.trigger("click");
    await flush();
    await nextTick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value.trim()).toBe("");
    wrapper.unmount();
  });

  it("exposes retry when transcription fails", async () => {
    localStorage.setItem("ADS_WEB_TASK_VOICE_INPUT", "1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: "Upstream error" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, text: "Retry success" }),
      });
    globalThis.fetch = fetchMock as any;

    const wrapper = mount(TaskCreateForm, { props: { models, workspaceRoot: "" } });
    const mic = wrapper.find("button.micIcon");
    await mic.trigger("click");
    await nextTick();
    await mic.trigger("click");
    await flush();
    await nextTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retry = wrapper.find("button.voiceRetryBtn");
    expect(retry.exists()).toBe(true);

    await retry.trigger("click");
    await flush();
    await nextTick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toContain("Retry success");
    wrapper.unmount();
  });
});
