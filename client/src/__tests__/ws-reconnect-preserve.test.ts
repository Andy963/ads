import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import { createAppController } from "../app/controller";

let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  clearHistory: () => void;
} | null = null;

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "planner" || chatSessionId === "reviewer") return;
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {
      // Let tests decide when to trigger onOpen/onMessage/onClose.
    }

    close(): void {}

    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
  }

  return { AdsWebSocket };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

async function mountReconnectHarness() {
  let controller: ReturnType<typeof createAppController> | null = null;
  const Harness = defineComponent({
    name: "ReconnectHarness",
    setup() {
      controller = createAppController();
      return {};
    },
    template: "<div />",
  });

  const wrapper = mount(Harness);
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  if (!controller) {
    throw new Error("controller not created");
  }

  controller.loggedIn.value = true;
  controller.currentUser.value = { id: "u-1", username: "admin" } as any;
  await controller.connectWs("default");
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  expect(lastWs).toBeTruthy();
  return { wrapper, controller, rt: controller.getRuntime("default") };
}

describe("WS reconnect preserves UI unless thread_reset", () => {
  beforeEach(() => {
    lastWs = null;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    lastWs = null;
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("does not clear messages on ws close", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { wrapper, rt } = await mountReconnectHarness();

    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    rt.activeThreadId.value = "thread-1";
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    expect(rt.messages.value.map((m: any) => m.content)).toEqual(["Hello", "World"]);
    expect(rt.activeThreadId.value).toBe("thread-1");
    expect(info).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps busy true on ws close until welcome resync clears it", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);

    await controller.connectWs("default");
    await settleUi(wrapper);
    expect(lastWs).toBeTruthy();

    lastWs!.onOpen?.();
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "welcome", inFlight: false });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    wrapper.unmount();
  });

  it("clears stale local chat continuity when welcome reports a fresh context with no thread", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { wrapper, rt } = await mountReconnectHarness();

    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Old question" },
      { id: "a1", role: "assistant", kind: "text", content: "Old answer" },
    ];
    rt.activeThreadId.value = "thread-stale";
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "welcome", inFlight: false, threadId: null, contextMode: "fresh" });
    await settleUi(wrapper);

    expect(rt.activeThreadId.value).toBeNull();
    const contents = rt.messages.value.map((m: any) => String(m.content ?? ""));
    expect(contents.join("\n")).not.toContain("Old question");
    expect(contents.join("\n")).not.toContain("Old answer");
    wrapper.unmount();
  });

  it("treats fresh welcome as authoritative even when an unexpected thread id is present", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { wrapper, rt } = await mountReconnectHarness();

    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Old question" },
      { id: "a1", role: "assistant", kind: "text", content: "Old answer" },
    ];
    rt.activeThreadId.value = "thread-stale";
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "welcome", inFlight: false, threadId: "thread-unexpected", contextMode: "fresh" });
    await settleUi(wrapper);

    expect(rt.activeThreadId.value).toBeNull();
    const contents = rt.messages.value.map((m: any) => String(m.content ?? ""));
    expect(contents.join("\n")).not.toContain("Old question");
    expect(contents.join("\n")).not.toContain("Old answer");
    wrapper.unmount();
  });

  it("clears messages and records a thread_reset reason when receiving thread_reset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { wrapper, rt } = await mountReconnectHarness();

    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    rt.activeThreadId.value = "thread-1";
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "thread_reset" });
    await settleUi(wrapper);

    const contents = rt.messages.value.map((m: any) => m.content);
    expect(contents.join("\n")).not.toContain("Hello");
    expect(contents.join("\n")).not.toContain("World");
    expect(info).toHaveBeenCalled();
    const args = info.mock.calls.map((c) => c[1]).filter(Boolean);
    expect(args.some((payload: any) => payload?.reason === "thread_reset")).toBe(true);
    wrapper.unmount();
  });

  it("suppresses the clear_history result bubble after user reset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { wrapper, controller, rt } = await mountReconnectHarness();

    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    await settleUi(wrapper);

    controller.clearActiveChat();
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "ignored", kind: "clear_history" });
    await settleUi(wrapper);

    expect(rt.messages.value).toHaveLength(0);
    expect(info).toHaveBeenCalled();
    wrapper.unmount();
  });
});
