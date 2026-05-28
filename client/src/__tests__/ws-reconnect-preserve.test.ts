import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import { createAppController } from "../app/controller";
import {
  RECONNECT_BUSY_MESSAGE,
  RECONNECT_PENDING_RESEND_NOTICE,
} from "../app/projectsWs/reconnectNotice";
import { EXECUTE_DISCONNECT_NOTICE } from "../lib/chat_sync";

const PENDING_PROMPT_REPLAY_NOTICE = "已恢复断线前未确认发送的请求，并重新发送。";

let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory: () => void;
} | null = null;
let lastSentPromptPayload: unknown = null;

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
      if (chatSessionId === "planner") return;
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {
      // Let tests decide when to trigger onOpen/onMessage/onClose.
    }

    close(): void {}

    send(): void {}
    sendPrompt(payload: unknown): void {
      lastSentPromptPayload = payload;
    }
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

function seedPendingReplayState(rt: any, chatSessionId: string, clientMessageId: string): void {
  rt.projectSessionId = "default";
  rt.pendingAckClientMessageId = clientMessageId;
  rt.queuedPrompts.value = [
    { id: `${chatSessionId}-queued`, clientMessageId, text: `${chatSessionId} prompt`, images: [], createdAt: Date.now() },
  ];
  sessionStorage.setItem(
    `ads.pendingPrompt.default.${chatSessionId}`,
    JSON.stringify({ clientMessageId, text: `${chatSessionId} prompt`, createdAt: Date.now() }),
  );
}

describe("WS reconnect preserves UI unless thread_reset", () => {
  beforeEach(() => {
    lastWs = null;
    lastSentPromptPayload = null;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    lastWs = null;
    lastSentPromptPayload = null;
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
    rt.awaitingBootstrapHistory = true;
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

  it("marks streaming execute output as incomplete before reconnect sync", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Run tests" },
      {
        id: "exec:npm-test",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "line 1",
        streaming: true,
      },
    ] as any;
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    const execute = rt.messages.value.find((m: any) => m.kind === "execute");
    expect(execute).toMatchObject({
      role: "system",
      kind: "execute",
      command: "npm test",
      streaming: false,
      content: `line 1\n${EXECUTE_DISCONNECT_NOTICE}`,
    });
    expect(String(execute?.id ?? "")).not.toMatch(/^exec:/);
    wrapper.unmount();
  });

  it("queues a stored pending prompt during busy reconnect and replays it after welcome idle", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.pendingAckClientMessageId = "pending-1";
    sessionStorage.setItem(
      "ads.pendingPrompt.default.main",
      JSON.stringify({ clientMessageId: "pending-1", text: "resume me", createdAt: Date.now(), agentId: "claude" }),
    );
    lastSentPromptPayload = null;
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    await controller.connectWs("default");
    await settleUi(wrapper);
    lastWs!.onOpen?.();
    await settleUi(wrapper);

    expect(rt.queuedPrompts.value).toHaveLength(1);
    expect(lastSentPromptPayload).toBeNull();

    lastWs!.onMessage?.({ type: "welcome", inFlight: false, effectiveModel: "gpt-4.1", effectiveModelReasoningEffort: "high" });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toMatchObject({
      text: "resume me",
      agentId: "claude",
      model: "gpt-4.1",
      model_reasoning_effort: "high",
    });
    expect(rt.queuedPrompts.value).toEqual([]);

    wrapper.unmount();
  });

  it("keeps a prompt queued when websocket send is not accepted", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    lastWs!.onOpen?.();
    await settleUi(wrapper);

    lastWs!.sendPrompt = vi.fn(() => false);
    controller.enqueuePrompt("send later", [], rt);
    await settleUi(wrapper);

    expect(lastWs!.sendPrompt).toHaveBeenCalledTimes(1);
    expect(rt.connected.value).toBe(false);
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value.map((q: any) => q.text)).toEqual(["send later"]);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain("send later");
    expect(sessionStorage.getItem("ads.pendingPrompt.default.main")).not.toBeNull();
    wrapper.unmount();
  });

  it("does not replay a pending prompt before bootstrap history can confirm completion", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-1";
    sessionStorage.setItem(
      "ads.pendingPrompt.default.main",
      JSON.stringify({ clientMessageId: "pending-1", text: "resume me", createdAt: Date.now(), agentId: "claude" }),
    );
    lastSentPromptPayload = null;
    await settleUi(wrapper);

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "thread_resumed", threadId: "thread-1" });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toBeNull();
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({ type: "in_flight", inFlight: false });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toBeNull();
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({
      type: "history",
      items: [
        { role: "user", text: "resume me", ts: 1 },
        { role: "ai", text: "done", ts: 2 },
      ],
    });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(sessionStorage.getItem("ads.pendingPrompt.default.main")).toBeNull();
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual(["resume me", "done"]);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(PENDING_PROMPT_REPLAY_NOTICE);
    wrapper.unmount();
  });

  it("does not drop a pending replay when only older history has the same text", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-new";
    sessionStorage.setItem(
      "ads.pendingPrompt.default.main",
      JSON.stringify({ clientMessageId: "pending-new", text: "repeat", createdAt: Date.now(), agentId: "claude" }),
    );
    lastSentPromptPayload = null;
    await settleUi(wrapper);

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "thread_resumed", threadId: "thread-1" });
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "history",
      items: [
        { role: "user", text: "repeat", ts: 1, kind: "client_message_id:older" },
        { role: "ai", text: "old answer", ts: 2 },
      ],
    });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toMatchObject({
      text: "repeat",
      agentId: "claude",
    });
    expect(rt.pendingAckClientMessageId).toBe("pending-new");
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain(PENDING_PROMPT_REPLAY_NOTICE);
    wrapper.unmount();
  });

  it("replays pending prompts after a reset welcome without waiting for history", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-reset";
    sessionStorage.setItem(
      "ads.pendingPrompt.default.main",
      JSON.stringify({ clientMessageId: "pending-reset", text: "run after reset", createdAt: Date.now(), agentId: "claude" }),
    );
    lastSentPromptPayload = null;
    await settleUi(wrapper);

    lastWs!.onOpen?.();
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "welcome", reset: true, inFlight: false, contextMode: "thread_resumed", threadId: "thread-1" });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toMatchObject({
      text: "run after reset",
      agentId: "claude",
    });
    expect(rt.awaitingBootstrapHistory).toBe(false);
    expect(rt.queuedPrompts.value).toEqual([]);
    wrapper.unmount();
  });

  it("removes the reconnect busy notice when bootstrap history arrives", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain(RECONNECT_BUSY_MESSAGE);

    lastWs!.onOpen?.();
    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "thread_resumed", threadId: "thread-1" });
    lastWs!.onMessage?.({
      type: "history",
      items: [
        { role: "user", text: "Hello", ts: 1 },
        { role: "ai", text: "World", ts: 2 },
      ],
    });
    await settleUi(wrapper);

    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual(["Hello", "World"]);
    wrapper.unmount();
  });

  it("uses the pending-resend reconnect notice when an ack is still outstanding", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.pendingAckClientMessageId = "pending-x";
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    const notices = rt.messages.value.map((m: any) => String(m.content ?? ""));
    expect(notices).toContain(RECONNECT_PENDING_RESEND_NOTICE);
    expect(notices).not.toContain(RECONNECT_BUSY_MESSAGE);
    wrapper.unmount();
  });

  it("drops the pending-resend reconnect notice when bootstrap history arrives", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.pendingAckClientMessageId = "pending-y";
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain(RECONNECT_PENDING_RESEND_NOTICE);

    lastWs!.onOpen?.();
    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "fresh" });
    lastWs!.onMessage?.({
      type: "history",
      items: [{ role: "user", text: "Hello", ts: 1 }],
    });
    await settleUi(wrapper);

    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_PENDING_RESEND_NOTICE);
    wrapper.unmount();
  });

  it("applies reconnect bootstrap history while backend work is still in flight", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Run tests" },
      { id: "a1", role: "assistant", kind: "text", content: "partial", streaming: true },
    ];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain(RECONNECT_BUSY_MESSAGE);

    lastWs!.onMessage?.({ type: "welcome", inFlight: true, contextMode: "fresh" });
    lastWs!.onMessage?.({
      type: "history",
      items: [{ role: "user", text: "Run tests", ts: 1, kind: "client_message_id:prompt-1" }],
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual(["Run tests"]);
    wrapper.unmount();
  });

  it.each([
    [4401, "Unauthorized"],
    [4409, "Max clients reached (increase ADS_WEB_MAX_CLIENTS)"],
  ])("clears busy and reconnect notice for terminal close code %s", async (code, expectedError) => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code, reason: "" });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.wsError.value).toBe(expectedError);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
    wrapper.unmount();
  });

  it("removes a reconnect notice and timer when a terminal close follows ws error", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onError?.();
    await settleUi(wrapper);

    expect(rt.reconnectTimer).not.toBeNull();
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain(RECONNECT_BUSY_MESSAGE);

    lastWs!.onClose?.({ code: 4401, reason: "unauthorized" });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.reconnectTimer).toBeNull();
    expect(rt.wsError.value).toBe("Unauthorized");
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
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
    expect(rt.awaitingBootstrapHistory).toBe(false);
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

  it("clears pending replay state when the user resets the active chat", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    seedPendingReplayState(rt, "main", "main-ack");
    await settleUi(wrapper);

    controller.clearActiveChat();
    await settleUi(wrapper);

    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(sessionStorage.getItem("ads.pendingPrompt.default.main")).toBeNull();
    expect(lastWs).toBeTruthy();
    expect(lastWs!.clearHistory).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("clears pending replay state for planner reset flows", async () => {
    const { wrapper, controller } = await mountReconnectHarness();
    const plannerRt = controller.getPlannerRuntime("default");

    seedPendingReplayState(plannerRt, "planner", "planner-ack");
    controller.clearPlannerChat();
    await settleUi(wrapper);

    expect(plannerRt.pendingAckClientMessageId).toBeNull();
    expect(plannerRt.queuedPrompts.value).toEqual([]);
    expect(sessionStorage.getItem("ads.pendingPrompt.default.planner")).toBeNull();
    wrapper.unmount();
  });
});
