import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";
import MainChatMessageList from "../components/MainChatMessageList.vue";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  clearHistory: () => void;
  sendPrompt: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async patch<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async delete<T>(): Promise<T> {
      throw new Error("not implemented");
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "advisor") return;
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {}
    close(): void {}

    send(): void {}
    sendPrompt = vi.fn();
    interrupt(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => {
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        this.$emit("logged-in", { id: "u-1", username: "admin" });
      },
      template: "<div />",
    }),
  };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

async function ensureWsConnected(wrapper: any): Promise<void> {
  if (!lastWs) {
    await wrapper.vm.connectWs?.();
    await settleUi(wrapper);
  }
  expect(lastWs).toBeTruthy();
  lastWs!.onOpen?.();
  await settleUi(wrapper);
}

type AppWrapper = { vm: any; unmount: () => void };

async function mountApp(): Promise<AppWrapper> {
  const App = (await import("../App.vue")).default;
  const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
  await settleUi(wrapper);
  await ensureWsConnected(wrapper);
  return wrapper as unknown as AppWrapper;
}

describe("failed turn preservation and in-place retry (Issue #221)", () => {
  beforeEach(() => {
    lastWs = null;
    localStorage.clear();
    sessionStorage.clear();
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWs = null;
    vi.clearAllMocks();
  });

  it("anchors a persistent error card on terminal failure and retries the original prompt in place", async () => {
    const wrapper = await mountApp();

    wrapper.vm.sendMainPrompt("please retry me");
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "error",
      message: "服务过载，请稍后重试",
      errorInfo: { code: "server_overloaded", retryable: true },
    });
    await settleUi(wrapper);

    const afterError = wrapper.vm.messages as Array<any>;
    const failureCards = afterError.filter((m) => m.role === "system" && m.kind === "error");
    expect(failureCards).toHaveLength(1);
    expect(failureCards[0]!.content).toBe("[server_overloaded] 服务过载，请稍后重试");
    const userIndex = afterError.findIndex((m) => m.role === "user" && String(m.content ?? "").includes("please retry me"));
    const cardIndex = afterError.findIndex((m) => m.id === failureCards[0]!.id);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThan(userIndex);
    expect(afterError.some((m) => m.role === "assistant" && m.streaming)).toBe(false);

    const sendCallsBefore = lastWs!.sendPrompt.mock.calls.length;
    wrapper.vm.retryPrompt(failureCards[0]);
    await settleUi(wrapper);

    const afterRetry = wrapper.vm.messages as Array<any>;
    expect(afterRetry.some((m) => m.id === failureCards[0]!.id)).toBe(false);
    const retriedUsers = afterRetry.filter((m) => m.role === "user" && String(m.content ?? "").includes("please retry me"));
    expect(retriedUsers).toHaveLength(1);
    expect(lastWs!.sendPrompt.mock.calls.length).toBe(sendCallsBefore + 1);
    const retriedPayload = lastWs!.sendPrompt.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(String(retriedPayload.text ?? "")).toContain("please retry me");
    expect(retriedPayload.replay_incomplete).toBe(true);
    expect(afterRetry.some((m) => m.role === "assistant" && m.streaming)).toBe(true);

    lastWs!.onMessage?.({ type: "error", message: "second failure" });
    await settleUi(wrapper);
    const secondFailure = (wrapper.vm.messages as Array<any>).find((m) => m.role === "system" && m.kind === "error");
    expect(secondFailure).toBeTruthy();
    wrapper.vm.retryPrompt(secondFailure);
    await settleUi(wrapper);
    expect((wrapper.vm.messages as Array<any>).filter((m) => m.role === "user" && String(m.content ?? "").includes("please retry me"))).toHaveLength(1);

    wrapper.unmount();
  });

  it("keeps an intentional interrupt in lane status without adding a failure card", async () => {
    const wrapper = await mountApp();

    wrapper.vm.sendMainPrompt("please stop me");
    await settleUi(wrapper);
    const interruptMessage = "\u5df2\u4e2d\u65ad\uff0c\u8f93\u51fa\u53ef\u80fd\u4e0d\u5b8c\u6574";
    lastWs!.onMessage?.({ type: "error", message: interruptMessage });
    await settleUi(wrapper);

    const messages = wrapper.vm.messages as Array<any>;
    expect(messages.filter((m) => m.role === "system" && m.kind === "error")).toHaveLength(0);
    expect(wrapper.vm.workerConnectionStatus).toEqual({ kind: "error", message: interruptMessage });

    wrapper.unmount();
  });

  it("does not restore an intentional interrupt as a failure card", async () => {
    const wrapper = await mountApp();
    const interruptMessage = "\u5df2\u4e2d\u65ad\uff0c\u8f93\u51fa\u53ef\u80fd\u4e0d\u5b8c\u6574";

    lastWs!.onMessage?.({
      type: "history",
      items: [
        { role: "user", text: "interrupted before reload", kind: "client_message_id:u-interrupted-1", ts: 1000 },
        { role: "status", kind: "error", text: interruptMessage, ts: 1010 },
      ],
    });
    await settleUi(wrapper);

    const messages = wrapper.vm.messages as Array<any>;
    expect(messages.filter((m) => m.role === "system" && m.kind === "error")).toHaveLength(0);
    expect(wrapper.vm.workerConnectionStatus).toEqual({ kind: "error", message: interruptMessage });

    wrapper.unmount();
  });

  it("replays a failed turn from history with the user message and error card intact, once", async () => {
    const wrapper = await mountApp();

    const historyFrame = {
      type: "history",
      items: [
        {
          role: "user",
          text: "failed before reload",
          kind: "client_message_id:u-reload-1;prompt_meta:model=gpt-5,effort=high",
          ts: 1000,
        },
        { role: "status", kind: "error", text: "[server_overloaded] 服务过载", ts: 1010 },
      ],
    };

    lastWs!.onMessage?.(historyFrame);
    await settleUi(wrapper);

    const afterReplay = wrapper.vm.messages as Array<any>;
    const users = afterReplay.filter((m) => m.role === "user" && String(m.content ?? "").includes("failed before reload"));
    expect(users).toHaveLength(1);
    expect(users[0]!.execution).toEqual({ model: "gpt-5", modelReasoningEffort: "high" });
    const cards = afterReplay.filter((m) => m.role === "system" && m.kind === "error");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("turn-failure:u-reload-1");
    expect(cards[0]!.content).toBe("[server_overloaded] 服务过载");
    expect(wrapper.vm.workerConnectionStatus).toEqual({ kind: "error", message: "[server_overloaded] 服务过载" });

    // A reconnect replaying the same history must not duplicate the turn.
    lastWs!.onMessage?.(historyFrame);
    await settleUi(wrapper);

    const afterReconnect = wrapper.vm.messages as Array<any>;
    expect(afterReconnect.filter((m) => m.role === "user" && String(m.content ?? "").includes("failed before reload"))).toHaveLength(1);
    expect(afterReconnect.filter((m) => m.role === "system" && m.kind === "error")).toHaveLength(1);

    wrapper.unmount();
  });

  it("keeps the failure card visible while a queued prompt advances automatically", async () => {
    const wrapper = await mountApp();

    wrapper.vm.sendMainPrompt("first");
    wrapper.vm.sendMainPrompt("second");
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "error", message: "first failed" });
    await settleUi(wrapper);

    const after = wrapper.vm.messages as Array<any>;
    const cards = after.filter((m) => m.role === "system" && m.kind === "error");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toBe("first failed");
    const firstUserIndex = after.findIndex((m) => m.role === "user" && m.content === "first");
    const cardIndex = after.findIndex((m) => m.id === cards[0]!.id);
    const secondUserIndex = after.findIndex((m) => m.role === "user" && m.content === "second");
    expect(cardIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThan(cardIndex);

    wrapper.unmount();
  });
});

describe("failed turn retry button", () => {
  it("renders a retry button on error cards and emits retryMessage", async () => {
    const errorMessage = {
      id: "turn-failure:u-1",
      role: "system" as const,
      kind: "error" as const,
      content: "[server_overloaded] 服务过载",
      ts: 2,
    };
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "u-1", role: "user" as const, kind: "text" as const, content: "failed prompt", ts: 1 },
          errorMessage,
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });
    await settleUi(wrapper);

    const retryButton = wrapper.get(".turnFailureRetryBtn");
    expect(retryButton.text()).toBe("重试");
    await retryButton.trigger("click");
    expect(wrapper.emitted("retryMessage")).toHaveLength(1);
    expect(wrapper.emitted("retryMessage")![0]).toEqual([errorMessage]);

    wrapper.unmount();
  });

  it("does not render a retry button on regular messages", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "a-1", role: "assistant" as const, kind: "text" as const, content: "plain answer", ts: 1 }],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });
    await settleUi(wrapper);

    expect(wrapper.find(".turnFailureRetryBtn").exists()).toBe(false);

    wrapper.unmount();
  });
});
