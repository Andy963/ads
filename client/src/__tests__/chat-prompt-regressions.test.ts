import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import { createOutboxStore, OUTBOX_CHANNEL_NAME } from "../app/outbox";
import type { ProjectRuntime } from "../app/controller";

// ---------------------------------------------------------------------------
// Shared harness (previously duplicated across issue-221 / error-placeholder-
// order / chat-prompt-error-preservation / issue-402 / issue-325 test files).
// ---------------------------------------------------------------------------

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
      if (chatSessionId === "acopilot") return;
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

// Harness driving the controller-level send path without mounting the App.
const mountHarness = (overrides: Partial<ProjectRuntime> = {}) => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = Object.assign(ctx.activeRuntime.value as ProjectRuntime, overrides);
  rt.projectSessionId = "session-1";
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  rt.ws = { sendPrompt: () => true } as never;
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: () => true } as never,
    randomId: (prefix: string) => `${prefix}-1`,
    maxTurnCommands: 5,
    updateProject: () => undefined,
    ...chat,
  } as never);
  return { chat, rt, handler };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Drives the real send path and returns the client id the runtime committed the
 * optimistic user bubble under.
 */
const sendPromptThroughRuntime = async (rt: ProjectRuntime, chat: ReturnType<typeof createChatActions>, text: string) => {
  chat.enqueuePrompt(text, [], rt);
  await settle();
  const bubble = rt.messages.value.find((message) => message.role === "user");
  expect(bubble).toBeDefined();
  return String(bubble?.id ?? "");
};

/** Simulates a sibling tab: the durable row exists here, the stream bubble does not. */
const dropUserBubbles = (rt: ProjectRuntime): void => {
  rt.messages.value = rt.messages.value.filter((message) => message.role !== "user");
};

const ackFrame = (clientMessageId: string, queueStatus = "queued") => ({
  type: "ack",
  client_message_id: clientMessageId,
  queue_status: queueStatus,
});

const queueEntry = (clientMessageId: string, status: string) => ({
  clientMessageId,
  text: "queued prompt",
  status,
  position: 0,
  attempts: 1,
  createdAt: 1000,
  updatedAt: 1000,
  lastError: status === "failed" ? "Prompt execution failed." : "",
  laneGeneration: 1,
});

const cardsFor = (rt: ProjectRuntime, clientMessageId: string) =>
  rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === clientMessageId);

// ---------------------------------------------------------------------------

describe("issue-221: failed turn preservation and in-place retry", () => {
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
    const originalClientMessageId = afterError[userIndex]!.id;

    const sendCallsBefore = lastWs!.sendPrompt.mock.calls.length;
    wrapper.vm.retryPrompt(failureCards[0]);
    await settleUi(wrapper);

    const afterRetry = wrapper.vm.messages as Array<any>;
    expect(afterRetry.some((m) => m.id === failureCards[0]!.id)).toBe(false);
    const retriedUsers = afterRetry.filter((m) => m.role === "user" && String(m.content ?? "").includes("please retry me"));
    expect(retriedUsers).toHaveLength(1);
    expect(lastWs!.sendPrompt.mock.calls.length).toBe(sendCallsBefore + 1);
    const retriedPayload = lastWs!.sendPrompt.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastWs!.sendPrompt.mock.calls.at(-1)?.[1]).toBe(originalClientMessageId);
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
    const interruptMessage = "已中断，输出可能不完整";
    lastWs!.onMessage?.({ type: "error", message: interruptMessage });
    await settleUi(wrapper);

    const messages = wrapper.vm.messages as Array<any>;
    expect(messages.filter((m) => m.role === "system" && m.kind === "error")).toHaveLength(0);
    expect(wrapper.vm.actionsConnectionStatus).toEqual({ kind: "error", message: interruptMessage });

    wrapper.unmount();
  });

  it("does not restore an intentional interrupt as a failure card", async () => {
    const wrapper = await mountApp();
    const interruptMessage = "已中断，输出可能不完整";

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
    expect(wrapper.vm.actionsConnectionStatus).toEqual({ kind: "error", message: interruptMessage });

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
    expect(wrapper.vm.actionsConnectionStatus).toEqual({ kind: "error", message: "[server_overloaded] 服务过载" });

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
    const secondClientMessageId = String(lastWs!.sendPrompt.mock.calls[1]?.[1] ?? "");

    lastWs!.onMessage?.({ type: "error", message: "first failed" });
    await settleUi(wrapper);

    const after = wrapper.vm.messages as Array<any>;
    const cards = after.filter((m) => m.role === "system" && m.kind === "error");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toBe("first failed");
    expect(after.some((m) => m.role === "user" && m.content === "second")).toBe(false);

    lastWs!.onMessage?.({ type: "user", clientMessageId: secondClientMessageId, text: "second" });
    await settleUi(wrapper);
    const afterSecondStart = wrapper.vm.messages as Array<any>;
    const firstUserIndex = afterSecondStart.findIndex((m) => m.role === "user" && m.content === "first");
    const cardIndex = afterSecondStart.findIndex((m) => m.id === cards[0]!.id);
    const secondUserIndex = afterSecondStart.findIndex((m) => m.role === "user" && m.content === "second");
    expect(cardIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThan(cardIndex);

    wrapper.unmount();
  });
});

describe("issue-221: failed turn retry button", () => {
  it("renders the inline retry icon inside the failed user message action row", async () => {
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

    const retryButton = wrapper.get(".bubble .msgActions .turnFailureRetryBtn");
    expect(retryButton.attributes("aria-label")).toBe("Retry message");
    expect(wrapper.find('[data-role="user"] .turnFailureRetryBtn').exists()).toBe(true);
    const msgActions = retryButton.element.closest(".msgActions");
    expect(msgActions).not.toBeNull();
    expect(msgActions!.querySelector(".msgCopyBtn")).not.toBeNull();
    expect(retryButton.element.closest(".bubble")).toBe(msgActions!.closest(".bubble"));
    expect(wrapper.find(".turnFailureActions").exists()).toBe(false);
    expect(wrapper.find('[data-role="system"][data-kind="error"]').exists()).toBe(false);
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

describe("issue-402: sent prompt renders once, not as a bubble plus a queue card", () => {
  it("does not append a card on ack when the bubble already renders the prompt", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPromptThroughRuntime(rt, chat, "hello from this tab");

    // The send path drops the optimistic card once the socket accepts it, so the
    // stream bubble is the only surviving rendering at ack time.
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(rt.messages.value.filter((message) => message.id === clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("still appends exactly one card on ack when the stream holds no matching bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPromptThroughRuntime(rt, chat, "queued behind a busy lane");
    dropUserBubbles(rt);

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)[0]?.serverQueueTracked).toBe(true);
  });

  it("does not append a card on prompt_queue when the bubble already renders the prompt", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPromptThroughRuntime(rt, chat, "hello again");

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "running") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("does not reconstruct a card from a running snapshot", async () => {
    const { rt, handler } = mountHarness();
    dropUserBubbles(rt);

    handler({ type: "prompt_queue_snapshot", entries: [queueEntry("cmid-running", "running")] } as never);
    await settle();

    expect(cardsFor(rt, "cmid-running")).toHaveLength(0);
    expect(rt.queuedPrompts.value.some((prompt) => prompt.text === "Server queued request")).toBe(false);
  });

  it("still appends exactly one card on prompt_queue when the stream holds no matching bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPromptThroughRuntime(rt, chat, "sent from another tab");
    dropUserBubbles(rt);

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "queued") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });

  it("keeps the retry card for a failed prompt that already has a bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPromptThroughRuntime(rt, chat, "this one fails");

    // De-duplication must not swallow the failure card: it is the only surface
    // carrying the retry action.
    handler(ackFrame(clientMessageId, "failed") as never);
    await settle();

    const failed = cardsFor(rt, clientMessageId);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.deliveryStatus).toBe("failed");

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "failed") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)[0]?.deliveryStatus).toBe("failed");
  });

  it("keeps the card for a replayed prompt that already has a bubble", async () => {
    const { rt, handler } = mountHarness();
    const clientMessageId = "cmid-replayed";
    // A reload replays the prompt with replay_incomplete. The bubble reappears,
    // but the card must survive until the backend confirms the replay landed.
    rt.messages.value = [...rt.messages.value, {
      id: clientMessageId,
      role: "user",
      kind: "text",
      content: "resumed after reload",
      ts: 1000,
    }];
    const outbox = createOutboxStore({ channelName: OUTBOX_CHANNEL_NAME });
    outbox.write("ads.outbox.session-1.main", {
      pending: null,
      sent: [{
        clientMessageId,
        text: "resumed after reload",
        createdAt: 1000,
        replayIncomplete: true,
        sentAwaitingAck: true,
      }],
      queued: [],
      dismissed: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });

  it("reconstructs cards for a sibling tab's prompt on reconnect snapshot", async () => {
    const { rt, handler } = mountHarness();
    dropUserBubbles(rt);

    handler({ type: "prompt_queue_snapshot", entries: [queueEntry("cmid-sibling", "queued")] } as never);
    await settle();

    expect(cardsFor(rt, "cmid-sibling")).toHaveLength(1);
  });

  it("removes the card on the user frame once the turn is committed", async () => {
    const { rt, handler } = mountHarness();
    dropUserBubbles(rt);

    handler({ type: "prompt_queue", entry: queueEntry("cmid-cleanup", "queued") } as never);
    await settle();
    expect(cardsFor(rt, "cmid-cleanup")).toHaveLength(1);

    handler({ type: "user", clientMessageId: "cmid-cleanup", text: "committed", kind: "text" } as never);
    await settle();

    expect(cardsFor(rt, "cmid-cleanup")).toHaveLength(0);
    expect(rt.messages.value.filter((message) => message.id === "cmid-cleanup")).toHaveLength(1);
  });
});

describe("issue-325: image attachment modernization", () => {
  it("renders 48x48 thumbnails with individual delete badges in composer and removes single image", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [
          { data: "data:image/png;base64,image1" },
          { data: "data:image/png;base64,image2" },
        ],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: {
        stubs: {
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);

    // Global clear button is removed
    expect(wrapper.find(".attachmentsClear").exists()).toBe(false);

    // Thumbnails have individual delete badges
    const thumbs = wrapper.findAll(".attachmentsThumbItem");
    expect(thumbs).toHaveLength(2);

    const deleteBadge0 = wrapper.find('[data-testid="attachment-remove-0"]');
    expect(deleteBadge0.exists()).toBe(true);
    const deleteBadge1 = wrapper.find('[data-testid="attachment-remove-1"]');
    expect(deleteBadge1.exists()).toBe(true);

    // Clicking remove badge 0 emits removeImage(0)
    await deleteBadge0.trigger("click");
    expect(wrapper.emitted("removeImage")?.[0]?.[0]).toBe(0);

    wrapper.unmount();
  });

  it("renders multiple user message images in compact 2-column gallery grid", async () => {
    const content = "Please inspect these screenshots:\n\n![attachment 1](/api/attachments/att-1/raw)\n![attachment 2](/api/attachments/att-2/raw)";
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "user-msg-1", role: "user", kind: "text", content, ts: 1000 }],
        copiedMessageId: null,
        formatMessageTs: () => "10:00",
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
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const grid = wrapper.find('[data-testid="msg-attachment-grid"]');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).not.toContain("msgAttachmentGrid--single");

    const thumbs = grid.findAll(".msgAttachmentThumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.find("img").attributes("src")).toBe("/api/attachments/att-1/raw");
    expect(thumbs[1]?.find("img").attributes("src")).toBe("/api/attachments/att-2/raw");

    // Clicking thumbnail triggers image viewer modal
    expect(wrapper.findComponent({ name: "MainChatPendingImageViewer" }).exists()).toBe(false);
    await thumbs[0]?.trigger("click");
    expect(wrapper.findComponent({ name: "MainChatPendingImageViewer" }).exists()).toBe(true);

    wrapper.unmount();
  });

  it("renders single user message image with single-image grid class", async () => {
    const content = "Single image:\n\n![attachment 1](/api/attachments/att-single/raw)";
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "user-msg-2", role: "user", kind: "text", content, ts: 2000 }],
        copiedMessageId: null,
        formatMessageTs: () => "10:05",
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
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const grid = wrapper.find('[data-testid="msg-attachment-grid"]');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).toContain("msgAttachmentGrid--single");
    expect(grid.findAll(".msgAttachmentThumb")).toHaveLength(1);

    wrapper.unmount();
  });
});

describe("chat-prompt-error-preservation: flushQueuedPrompts error handling", () => {
  it("sends a prompt immediately while the current runtime is busy", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    rt.connected.value = true;
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.ws = {
      sendPrompt: vi.fn().mockReturnValue(true),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    chat.enqueuePrompt("Queue this behind the active turn", []);

    expect(rt.ws.sendPrompt).toHaveBeenCalledTimes(1);
    expect(rt.queuedPrompts.value).toHaveLength(0);
  });

  it("preserves user message bubble in transcript when ws sendPrompt fails", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    rt.connected.value = true;
    rt.ws = {
      sendPrompt: vi.fn().mockReturnValue(false),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    chat.enqueuePrompt("Analyze database deadlock issue", []);

    expect(rt.ws?.sendPrompt).toHaveBeenCalled();

    // User message bubble must be preserved
    const userMessages = rt.messages.value.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("Analyze database deadlock issue");

    // Empty assistant placeholder must be dropped
    const assistantMessages = rt.messages.value.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);

    // State flags must be cleared
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.connected.value).toBe(false);

    // Failed prompt must remain in queuedPrompts for retry
    expect(rt.queuedPrompts.value).toHaveLength(1);
    expect(rt.queuedPrompts.value[0]?.text).toBe("Analyze database deadlock issue");
  });

  it("does not duplicate user bubble if retry is flushed again", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const rt = ctx.activeRuntime.value;

    let allowSend = false;
    rt.connected.value = true;
    rt.ws = {
      sendPrompt: vi.fn().mockImplementation(() => allowSend),
      clearHistory: vi.fn(),
    } as unknown as typeof rt.ws;

    chat.enqueuePrompt("Check server logs", []);
    expect(rt.messages.value.filter((m) => m.role === "user")).toHaveLength(1);

    // Reconnect and retry
    rt.connected.value = true;
    allowSend = true;
    await chat.flushQueuedPrompts(rt);

    // User message should still only have 1 entry
    const userMessages = rt.messages.value.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("Check server logs");
  });
});

describe("error-placeholder-order: error placeholder cleanup", () => {
  it("drops the assistant streaming placeholder on backend error so the next user prompt does not appear below it", async () => {
    const wrapper = await mountApp();

    (wrapper.vm as any).sendMainPrompt("first");
    await settleUi(wrapper);

    const afterFirst = (wrapper.vm as any).messages as Array<any>;
    expect(afterFirst.some((m) => m.role === "assistant" && m.streaming)).toBe(true);

    lastWs!.onMessage?.({ type: "error", message: "boom" });
    await settleUi(wrapper);

    const afterError = (wrapper.vm as any).messages as Array<any>;
    expect(afterError.some((m) => m.role === "assistant" && m.streaming)).toBe(false);
    const failureCards = afterError.filter((m) => m.role === "system" && m.kind === "error");
    expect(failureCards).toHaveLength(1);
    expect(failureCards[0].content).toBe("boom");
    expect((wrapper.vm as any).actionsConnectionStatus).toEqual({ kind: "error", message: "boom" });

    (wrapper.vm as any).sendMainPrompt("second");
    await settleUi(wrapper);

    const afterSecond = (wrapper.vm as any).messages as Array<any>;
    const userIdx = afterSecond.findIndex((m) => m.role === "user" && String(m.content ?? "").includes("second"));
    const assistantIdx = afterSecond.findIndex((m, idx) => idx > userIdx && m.role === "assistant" && m.streaming);

    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(userIdx);
    expect(afterSecond.filter((m) => m.role === "assistant" && m.streaming).length).toBe(1);

    wrapper.unmount();
  });

  it("coalesces transient retry errors into one notice and clears it on success", async () => {
    const wrapper = await mountApp();

    (wrapper.vm as any).sendMainPrompt("retry please");
    await settleUi(wrapper);

    const message = "We're currently experiencing high demand, which may cause temporary errors.";
    lastWs!.onMessage?.({ type: "error", message, transient: true, retryable: true, retryCount: 1 });
    lastWs!.onMessage?.({ type: "error", message, transient: true, retryable: true, retryCount: 2 });
    await settleUi(wrapper);

    const duringRetry = (wrapper.vm as any).messages as Array<any>;
    const retryNotices = duringRetry.filter((m) => m.kind === "error" && m.transient === true);
    expect(retryNotices).toHaveLength(0);
    expect((wrapper.vm as any).actionsConnectionStatus).toEqual({
      kind: "progress",
      message: `${message}（第 2 次重试）`,
    });
    expect(duringRetry.some((m) => m.role === "assistant" && m.streaming)).toBe(true);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "done" });
    await settleUi(wrapper);

    const afterResult = (wrapper.vm as any).messages as Array<any>;
    expect(afterResult.some((m) => m.kind === "error" && m.transient === true)).toBe(false);
    expect(afterResult.some((m) => m.role === "assistant" && String(m.content ?? "").includes("done"))).toBe(true);
    expect((wrapper.vm as any).actionsConnectionStatus).toBeNull();

    wrapper.unmount();
  });

  it("preserves a failed-turn error while automatically advancing a queued prompt", async () => {
    const wrapper = await mountApp();

    (wrapper.vm as any).sendMainPrompt("first");
    (wrapper.vm as any).sendMainPrompt("second");
    await settleUi(wrapper);

    expect((wrapper.vm as any).queuedPrompts).toHaveLength(0);
    expect(lastWs!.sendPrompt).toHaveBeenCalledTimes(2);
    const secondClientMessageId = String(lastWs!.sendPrompt.mock.calls[1]?.[1] ?? "");

    lastWs!.onMessage?.({ type: "error", message: "first failed" });
    await settleUi(wrapper);

    expect((wrapper.vm as any).queuedPrompts).toHaveLength(0);
    expect((wrapper.vm as any).actionsConnectionStatus).toEqual({ kind: "error", message: "first failed" });
    expect(lastWs!.sendPrompt).toHaveBeenCalledTimes(2);

    lastWs!.onMessage?.({ type: "user", clientMessageId: secondClientMessageId, text: "second" });
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "second done" });
    await settleUi(wrapper);

    expect((wrapper.vm as any).actionsConnectionStatus).toBeNull();
    wrapper.unmount();
  });
});
