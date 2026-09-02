import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import { createAppController } from "../app/controller";
import {
  RECONNECT_BUSY_MESSAGE,
  RECONNECT_PENDING_RESEND_NOTICE,
} from "../app/projectsWs/reconnectNotice";

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

/** Seed the durable outbox the way a previous tab would have left it. */
function seedOutboxPending(chatSessionId: string, pending: Record<string, unknown>): void {
  localStorage.setItem(`ads.outbox.default.${chatSessionId}`, JSON.stringify({ pending, queued: [] }));
}

function seedPendingReplayState(rt: any, chatSessionId: string, clientMessageId: string): void {
  rt.projectSessionId = "default";
  rt.pendingAckClientMessageId = clientMessageId;
  rt.queuedPrompts.value = [
    { id: `${chatSessionId}-queued`, clientMessageId, text: `${chatSessionId} prompt`, images: [], createdAt: Date.now() },
  ];
  seedOutboxPending(chatSessionId, { clientMessageId, text: `${chatSessionId} prompt`, createdAt: Date.now() });
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

  it("catches up missed sync history events after reconnect", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [
            {
              seq: 1,
              type: "history",
              revision: 1,
              ts: Date.now(),
              payload: {
                type: "history",
                items: [
                  { role: "user", text: "offline question", ts: 1 },
                  { role: "ai", text: "offline answer", ts: 2 },
                ],
              },
            },
          ],
          latestSeq: 1,
          minAvailableSeq: 1,
          hasMore: false,
          truncated: false,
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { wrapper, rt } = await mountReconnectHarness();
      rt.needsChatSync = true;

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({ type: "welcome", latestSeq: 1, inFlight: false });

      await vi.waitFor(() => {
        expect(rt.messages.value.map((message) => message.content)).toContain("offline answer");
      });
      expect(sessionStorage.getItem("ads.syncCursor.default.main")).toContain("\"lastSeq\":1");
      expect(localStorage.getItem("ads.syncCursor.default.main")).toBeNull();

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("orders HTTP catch-up and overlapping live events through one sequencer", async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { wrapper, rt } = await mountReconnectHarness();
      rt.needsChatSync = true;

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({ type: "welcome", latestSeq: 2, inFlight: false });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      lastWs!.onMessage?.({ type: "delta", delta: "B", seq: 2 });
      await settleUi(wrapper);
      expect(rt.messages.value).toEqual([]);

      resolveFetch?.({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              { seq: 1, type: "delta", revision: 1, ts: 1, payload: { type: "delta", delta: "A" } },
              { seq: 2, type: "delta", revision: 1, ts: 2, payload: { type: "delta", delta: "B" } },
            ],
            latestSeq: 2,
            minAvailableSeq: 1,
            hasMore: false,
            truncated: false,
          }),
      } as Response);

      await vi.waitFor(() => {
        expect(rt.messages.value.map((message) => message.content)).toEqual(["AB"]);
      });
      expect(sessionStorage.getItem("ads.syncCursor.default.main")).toContain("\"lastSeq\":2");

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resumes an in-flight stream from delta_snapshot instead of losing the missed text", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [
            // Two snapshots: the client's cursor may land between flushes, and each
            // one carries absolute text, so applying both must not concatenate.
            {
              seq: 4,
              type: "delta_snapshot",
              revision: 1,
              ts: 4,
              payload: { type: "delta_snapshot", text: "Partial ans", revision: 1 },
            },
            {
              seq: 5,
              type: "delta_snapshot",
              revision: 2,
              ts: 5,
              payload: { type: "delta_snapshot", text: "Partial answer so far", revision: 2 },
            },
          ],
          latestSeq: 5,
          minAvailableSeq: 4,
          hasMore: false,
          truncated: false,
        }),
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    sessionStorage.setItem("ads.syncCursor.default.main", JSON.stringify({ lastSeq: 3 }));
    try {
      const { wrapper, rt } = await mountReconnectHarness();

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({ type: "welcome", latestSeq: 5, inFlight: true });

      await vi.waitFor(() => {
        expect(
          rt.messages.value.filter((message) => message.role === "assistant").map((message) => message.content),
        ).toEqual(["Partial answer so far"]);
      });
      // The turn is still running, so the block stays live and the composer stays busy.
      expect(rt.messages.value.some((message) => message.streaming === true)).toBe(true);
      expect(rt.busy.value).toBe(true);

      // A live delta arriving after catch-up appends to the resumed text.
      lastWs!.onMessage?.({ type: "delta", delta: " and more", seq: 6 });
      await settleUi(wrapper);
      expect(
        rt.messages.value.filter((message) => message.role === "assistant").map((message) => message.content),
      ).toEqual(["Partial answer so far and more"]);

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("defers unsequenced bootstrap history until catch-up finishes", async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    sessionStorage.setItem("ads.syncCursor.default.main", JSON.stringify({ lastSeq: 1 }));
    try {
      const { wrapper, rt } = await mountReconnectHarness();

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({
        type: "welcome",
        latestSeq: 3,
        inFlight: false,
        contextMode: "thread_resumed",
        threadId: "thread-1",
        bootstrapHistory: true,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      resolveFetch?.({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              { seq: 2, type: "delta", revision: 1, ts: 2, payload: { type: "delta", delta: "answer" } },
              { seq: 3, type: "result", revision: 1, ts: 3, payload: { type: "result", ok: true, output: "answer" } },
            ],
            latestSeq: 3,
            minAvailableSeq: 2,
            hasMore: false,
            truncated: false,
          }),
      } as Response);
      await settleUi(wrapper);
      expect(rt.messages.value).toEqual([]);

      lastWs!.onMessage?.({
        type: "history",
        items: [
          { role: "user", text: "question", ts: 1 },
          { role: "ai", text: "answer", ts: 2 },
        ],
      });

      await vi.waitFor(() => {
        expect(rt.messages.value.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
          "answer",
        ]);
      });
      expect(rt.messages.value.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        "question",
      ]);

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps an idle terminal bootstrap authoritative over covered turn and task events", async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { wrapper, rt } = await mountReconnectHarness();

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({
        type: "welcome",
        latestSeq: 10,
        inFlight: false,
        contextMode: "thread_resumed",
        threadId: "thread-1",
        bootstrapHistory: true,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      resolveFetch?.({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              { seq: 1, type: "in_flight", revision: 1, ts: 1, payload: { type: "in_flight", inFlight: true } },
              {
                seq: 2,
                type: "patch",
                revision: 1,
                ts: 2,
                payload: {
                  type: "patch",
                  patch: {
                    files: [{ path: "old.ts", added: 1, removed: 0 }],
                    diff: "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ b/old.ts\n@@ -1 +1 @@\n-old\n+older",
                  },
                },
              },
              { seq: 3, type: "result", revision: 1, ts: 3, payload: { type: "result", ok: true, output: "old answer" } },
              { seq: 4, type: "in_flight", revision: 1, ts: 4, payload: { type: "in_flight", inFlight: true } },
              {
                seq: 5,
                type: "command",
                revision: 1,
                ts: 5,
                payload: { type: "command", command: { id: "cmd-1", command: "npm test", outputDelta: "running\n" } },
              },
              {
                seq: 6,
                type: "patch",
                revision: 1,
                ts: 6,
                payload: {
                  type: "patch",
                  patch: {
                    files: [{ path: "server.ts", added: 1, removed: 0 }],
                    diff: "diff --git a/server.ts b/server.ts\n--- a/server.ts\n+++ b/server.ts\n@@ -1 +1 @@\n-old\n+new",
                  },
                },
              },
              {
                seq: 7,
                type: "patch",
                revision: 1,
                ts: 7,
                payload: {
                  type: "patch",
                  patch: {
                    files: [{ path: "client.ts", added: 2, removed: 1 }],
                    diff: "diff --git a/client.ts b/client.ts\n--- a/client.ts\n+++ b/client.ts\n@@ -1 +1 @@\n-before\n+after",
                  },
                },
              },
              {
                seq: 8,
                type: "task:event",
                revision: 1,
                ts: 8,
                payload: {
                  type: "task:event",
                  event: "message:delta",
                  data: { taskId: "task-1", role: "assistant", delta: "stale task delta" },
                },
              },
              { seq: 9, type: "result", revision: 1, ts: 9, payload: { type: "result", ok: true, output: "final answer" } },
              { seq: 10, type: "result", revision: 1, ts: 10, payload: { type: "result", ok: false, output: "错误: bad path" } },
            ],
            latestSeq: 10,
            minAvailableSeq: 1,
            hasMore: false,
            truncated: false,
          }),
      } as Response);
      await settleUi(wrapper);

      lastWs!.onMessage?.({
        type: "history",
        items: [
          { role: "user", text: "old question", ts: 1 },
          { role: "ai", text: "old answer", ts: 3 },
          { role: "user", text: "question", ts: 4 },
          { role: "ai", text: "final answer", ts: 9 },
          { role: "status", text: "错误: bad path", ts: 10, kind: "error" },
        ],
      });

      await vi.waitFor(() => {
        expect(rt.messages.value.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
          "old answer",
          "final answer",
        ]);
      });
      expect(rt.messages.value.map((message) => String(message.content ?? ""))).not.toContain("stale task delta");
      expect(rt.messages.value.some((message) => message.kind === "execute")).toBe(false);
      const patchMessages = rt.messages.value.filter((message) => message.kind === "patch");
      expect(patchMessages).toHaveLength(1);
      expect(patchMessages[0]?.content).not.toContain("diff --git a/old.ts b/old.ts");
      expect(patchMessages[0]?.content).toContain("diff --git a/server.ts b/server.ts");
      expect(patchMessages[0]?.content).toContain("diff --git a/client.ts b/client.ts");
      const patchIndex = rt.messages.value.findIndex((message) => message.kind === "patch");
      let assistantIndex = -1;
      for (let index = rt.messages.value.length - 1; index >= 0; index -= 1) {
        if (rt.messages.value[index]?.role === "assistant") {
          assistantIndex = index;
          break;
        }
      }
      expect(patchIndex).toBeGreaterThanOrEqual(0);
      expect(patchIndex).toBeLessThan(assistantIndex);
      expect(rt.busy.value).toBe(false);
      expect(rt.turnInFlight).toBe(false);
      expect(rt.inputLocked.value).toBe(false);
      expect(rt.laneStatus.value).toEqual({ kind: "error", message: "错误: bad path" });
      expect(sessionStorage.getItem("ads.syncCursor.default.main")).toContain('"lastSeq":10');

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not advance the cursor with live events when catch-up fails", async () => {
    const originalFetch = globalThis.fetch;
    let rejectFetch: ((error: Error) => void) | null = null;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { wrapper, rt } = await mountReconnectHarness();
      rt.needsChatSync = true;

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({ type: "welcome", latestSeq: 5, inFlight: false });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      lastWs!.onMessage?.({ type: "delta", delta: "must wait", seq: 5 });
      rejectFetch?.(new Error("temporary fetch failure"));
      await settleUi(wrapper);

      expect(rt.messages.value).toEqual([]);
      expect(sessionStorage.getItem("ads.syncCursor.default.main")).toBeNull();
      expect(rt.needsChatSync).toBe(true);

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rebuilds the lane from a snapshot when the retained event window is truncated", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [],
          latestSeq: 9,
          minAvailableSeq: 7,
          hasMore: false,
          truncated: true,
          snapshot: {
            type: "history",
            items: [
              { role: "user", text: "snapshot question", ts: 1 },
              { role: "ai", text: "snapshot answer", ts: 2 },
            ],
          },
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { wrapper, rt } = await mountReconnectHarness();
      rt.messages.value = [{ id: "stale", role: "assistant", kind: "text", content: "stale" }];
      sessionStorage.setItem("ads.syncCursor.default.main", JSON.stringify({ lastSeq: 1 }));
      rt.needsChatSync = true;

      lastWs!.onOpen?.();
      lastWs!.onMessage?.({ type: "welcome", latestSeq: 9, inFlight: false });

      await vi.waitFor(() => {
        expect(rt.messages.value.map((message) => message.content)).toEqual(["snapshot question", "snapshot answer"]);
      });
      expect(sessionStorage.getItem("ads.syncCursor.default.main")).toContain("\"lastSeq\":9");
      expect(rt.apiNotice.value).toBe("同步记录窗口已过期，已从后端快照恢复。");

      wrapper.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toBeNull();
    wrapper.unmount();
  });

  it("drops transient execute previews while reconnecting", async () => {
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

    expect(rt.messages.value.some((m: any) => m.kind === "execute")).toBe(false);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: RECONNECT_BUSY_MESSAGE });
    wrapper.unmount();
  });

  it("queues a stored pending prompt during busy reconnect and replays it after welcome idle", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.pendingAckClientMessageId = "pending-1";
    seedOutboxPending("main", { clientMessageId: "pending-1", text: "resume me", createdAt: Date.now(), agentId: "claude" });
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
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toContain("send later");
    expect(localStorage.getItem("ads.outbox.default.main")).not.toBeNull();
    wrapper.unmount();
  });

  it("does not replay a pending prompt before bootstrap history can confirm completion", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-1";
    seedOutboxPending("main", { clientMessageId: "pending-1", text: "resume me", createdAt: Date.now(), agentId: "claude" });
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
    expect(localStorage.getItem("ads.outbox.default.main")).toBeNull();
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual(["resume me", "done"]);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(PENDING_PROMPT_REPLAY_NOTICE);
    wrapper.unmount();
  });

  it("restores queued prompts that were never sent, not just the pending one", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    // What a tab that was closed with a full outbox would have left behind.
    localStorage.setItem(
      "ads.outbox.default.main",
      JSON.stringify({
        pending: { clientMessageId: "pending-1", text: "already sent", createdAt: 1, agentId: "claude" },
        queued: [
          { clientMessageId: "queued-1", text: "next up", createdAt: 2 },
          { clientMessageId: "queued-2", text: "and then this", createdAt: 3 },
        ],
      }),
    );

    lastWs!.onOpen?.();
    await settleUi(wrapper);

    expect(rt.queuedPrompts.value.map((q: any) => q.text)).toEqual([
      "already sent",
      "next up",
      "and then this",
    ]);
    // Only the prompt that actually reached the server replays as a resend.
    expect(rt.queuedPrompts.value.map((q: any) => q.restoredFromStorage === true)).toEqual([true, false, false]);
    wrapper.unmount();
  });

  it("adopts a pending prompt left by the previous sessionStorage layout", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    sessionStorage.setItem(
      "ads.pendingPrompt.default.main",
      JSON.stringify({ clientMessageId: "legacy-1", text: "written before the upgrade", createdAt: 1 }),
    );

    lastWs!.onOpen?.();
    await settleUi(wrapper);

    expect(rt.queuedPrompts.value.map((q: any) => q.text)).toEqual(["written before the upgrade"]);
    expect(sessionStorage.getItem("ads.pendingPrompt.default.main")).toBeNull();
    wrapper.unmount();
  });

  it("persists newly queued prompts so a reload does not drop them", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    rt.connected.value = false;
    rt.projectSessionId = "default";
    controller.enqueuePrompt("queued while offline", [], rt);
    await settleUi(wrapper);

    const stored = JSON.parse(String(localStorage.getItem("ads.outbox.default.main"))) as {
      queued: Array<{ text: string }>;
    };
    expect(stored.queued.map((entry) => entry.text)).toEqual(["queued while offline"]);
    wrapper.unmount();
  });

  it("reconciles an unacked prompt before preserving a fresh in-flight run", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-fresh";
    seedOutboxPending("main", { clientMessageId: "pending-fresh", text: "keep running", createdAt: Date.now(), agentId: "claude" });
    lastSentPromptPayload = null;

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({ type: "welcome", inFlight: true, contextMode: "fresh" });
    await settleUi(wrapper);

    expect(rt.awaitingBootstrapHistory).toBe(true);
    expect(lastSentPromptPayload).toBeNull();

    lastWs!.onMessage?.({
      type: "history",
      items: [
        {
          role: "user",
          text: "keep running",
          ts: 1,
          kind: "client_message_id:pending-fresh;prompt_meta:agent=claude,model=claude-opus-4-8,effort=max",
        },
      ],
    });
    await settleUi(wrapper);

    expect(rt.awaitingBootstrapHistory).toBe(false);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(localStorage.getItem("ads.outbox.default.main")).toBeNull();
    expect(lastSentPromptPayload).toBeNull();
    expect(rt.busy.value).toBe(true);
    expect(rt.inputLocked.value).toBe(true);
    wrapper.unmount();
  });

  it("replays an unacked prompt when bootstrap history only has a user entry and backend is idle", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-user-only";
    seedOutboxPending("main", { clientMessageId: "pending-user-only", text: "continue this work", createdAt: Date.now(), agentId: "claude" });
    lastSentPromptPayload = null;

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({
      type: "welcome",
      inFlight: false,
      contextMode: "fresh",
      bootstrapHistory: true,
    });
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "history",
      items: [
        {
          role: "user",
          text: "continue this work",
          ts: 1,
          kind: "client_message_id:pending-user-only;prompt_meta:agent=claude",
        },
      ],
    });
    await settleUi(wrapper);

    expect(lastSentPromptPayload).toMatchObject({
      text: "continue this work",
      agentId: "claude",
      replay_incomplete: true,
    });
    expect(rt.pendingAckClientMessageId).toBe("pending-user-only");
    expect(rt.queuedPrompts.value).toEqual([]);
    wrapper.unmount();
  });

  it("reconciles completed fresh prompts from welcome metadata before resending", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-completed";
    seedOutboxPending("main", { clientMessageId: "pending-completed", text: "run tests", createdAt: Date.now(), agentId: "claude" });
    lastSentPromptPayload = null;

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    expect(rt.queuedPrompts.value).toHaveLength(1);

    lastWs!.onMessage?.({
      type: "welcome",
      inFlight: false,
      contextMode: "fresh",
      bootstrapHistory: false,
      completedClientMessageIds: ["pending-completed"],
    });
    await settleUi(wrapper);

    expect(rt.awaitingBootstrapHistory).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
    expect(lastSentPromptPayload).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(localStorage.getItem("ads.outbox.default.main")).toBeNull();
    expect(lastSentPromptPayload).toBeNull();
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.messages.value).toEqual([]);
    wrapper.unmount();
  });

  it("reconciles ignored bootstrap history before clearing the pending wait", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.ignoreNextHistory = true;
    rt.pendingAckClientMessageId = "pending-ignored";
    seedOutboxPending("main", { clientMessageId: "pending-ignored", text: "run ignored", createdAt: Date.now(), agentId: "claude" });
    lastSentPromptPayload = null;

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    lastWs!.onMessage?.({
      type: "welcome",
      inFlight: false,
      contextMode: "fresh",
      bootstrapHistory: true,
    });
    await settleUi(wrapper);

    expect(rt.awaitingBootstrapHistory).toBe(true);
    expect(rt.inputLocked.value).toBe(true);

    lastWs!.onMessage?.({
      type: "history",
      items: [
        {
          role: "user",
          text: "run ignored",
          ts: 1,
          kind: "client_message_id:pending-ignored;prompt_meta:agent=claude",
        },
        { role: "status", text: "request failed", ts: 2, kind: "error" },
      ],
    });
    await settleUi(wrapper);

    expect(rt.ignoreNextHistory).toBe(false);
    expect(rt.awaitingBootstrapHistory).toBe(false);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(localStorage.getItem("ads.outbox.default.main")).toBeNull();
    expect(lastSentPromptPayload).toBeNull();
    expect(rt.inputLocked.value).toBe(false);
    wrapper.unmount();
  });

  it("does not drop a pending replay when only older history has the same text", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-new";
    seedOutboxPending("main", { clientMessageId: "pending-new", text: "repeat", createdAt: Date.now(), agentId: "claude" });
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
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(PENDING_PROMPT_REPLAY_NOTICE);
    expect(rt.inputLocked.value).toBe(true);
    wrapper.unmount();
  });

  it("replays pending prompts after a reset welcome without waiting for history", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.pendingAckClientMessageId = "pending-reset";
    seedOutboxPending("main", { clientMessageId: "pending-reset", text: "run after reset", createdAt: Date.now(), agentId: "claude" });
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

  it("shows reconnect state outside history and clears it when bootstrap history arrives", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "Hello" }];
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: RECONNECT_BUSY_MESSAGE });
    expect(rt.inputLocked.value).toBe(true);

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
    expect(rt.laneStatus.value).toBeNull();
    expect(rt.inputLocked.value).toBe(false);
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
    expect(notices).not.toContain(RECONNECT_PENDING_RESEND_NOTICE);
    expect(notices).not.toContain(RECONNECT_BUSY_MESSAGE);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: RECONNECT_PENDING_RESEND_NOTICE });
    expect(rt.inputLocked.value).toBe(true);
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
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_PENDING_RESEND_NOTICE);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: RECONNECT_PENDING_RESEND_NOTICE });

    lastWs!.onOpen?.();
    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "fresh" });
    lastWs!.onMessage?.({
      type: "history",
      items: [{ role: "user", text: "Hello", ts: 1 }],
    });
    await settleUi(wrapper);

    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_PENDING_RESEND_NOTICE);
    expect(rt.laneStatus.value).toEqual({
      kind: "info",
      message: "后端已是全新上下文。为避免误导，旧的本地聊天历史已清空。",
    });
    expect(rt.inputLocked.value).toBe(false);
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
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
    expect(rt.inputLocked.value).toBe(true);

    lastWs!.onMessage?.({ type: "welcome", inFlight: true, contextMode: "fresh" });
    lastWs!.onMessage?.({
      type: "history",
      items: [{ role: "user", text: "Run tests", ts: 1, kind: "client_message_id:prompt-1" }],
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).toEqual(["Run tests"]);
    expect(rt.inputLocked.value).toBe(true);
    expect(rt.laneStatus.value?.message).toBe("上一轮仍在执行，正在等待后端结果…");

    lastWs!.onMessage?.({
      type: "command",
      command: {
        id: "cmd-1",
        command: "npm test",
        outputDelta: "Tests are running\n",
      },
    });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.inputLocked.value).toBe(true);
    expect(rt.laneStatus.value).toBeNull();

    lastWs!.onMessage?.({ type: "result", ok: true, output: "All tests passed", threadId: "thread-1" });
    await settleUi(wrapper);

    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toBeNull();
    wrapper.unmount();
  });

  it("keeps server-reported in-flight state when history already contains an assistant result", async () => {
    const { wrapper, rt } = await mountReconnectHarness();

    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.inputLocked.value = true;
    rt.laneStatus.value = { kind: "progress", message: RECONNECT_BUSY_MESSAGE };

    lastWs!.onMessage?.({ type: "welcome", inFlight: true, contextMode: "fresh" });
    lastWs!.onMessage?.({
      type: "history",
      items: [
        { role: "user", text: "Run tests", ts: 1 },
        { role: "ai", text: "All tests passed", ts: 2 },
      ],
    });
    lastWs!.onMessage?.({ type: "status", kind: "status", message: "上一轮仍在执行，正在等待后端结果。" });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.inputLocked.value).toBe(true);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: "上一轮仍在执行，正在等待后端结果。" });
    expect(rt.messages.value.map((item: any) => item.content)).toEqual(["Run tests", "All tests passed"]);
    wrapper.unmount();
  });

  it("unlocks when a pending resume request is lost before an idle fresh reconnect", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    await controller.resumeTaskThread();
    await settleUi(wrapper);

    expect(rt.resumeReplacePending).toBe(true);
    expect(rt.inputLocked.value).toBe(true);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);
    lastWs!.onOpen?.();
    lastWs!.onMessage?.({ type: "welcome", inFlight: false, contextMode: "fresh" });
    await settleUi(wrapper);

    expect(rt.resumeReplacePending).toBe(false);
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toEqual({ kind: "error", message: "恢复请求未确认，请重试。" });
    wrapper.unmount();
  });

  it("locks the composer while restoring context and unlocks after history arrives", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    lastWs!.onOpen?.();
    await settleUi(wrapper);
    await controller.resumeTaskThread();
    await settleUi(wrapper);

    expect(rt.inputLocked.value).toBe(true);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: "正在恢复上下文…" });

    controller.sendMainPrompt("must not be queued");
    expect(rt.queuedPrompts.value).toEqual([]);

    lastWs!.onMessage?.({
      type: "history",
      contextMode: "thread_resumed",
      threadId: "thread-restored",
      items: [
        { role: "user", text: "previous question", ts: 1 },
        { role: "ai", text: "previous answer", ts: 2 },
      ],
    });
    await settleUi(wrapper);

    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toBeNull();
    expect(rt.messages.value.map((item: any) => item.content)).toEqual(["previous question", "previous answer"]);
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
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toBeNull();
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
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: RECONNECT_BUSY_MESSAGE });

    lastWs!.onClose?.({ code: 4401, reason: "unauthorized" });
    await settleUi(wrapper);

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.reconnectTimer).toBeNull();
    expect(rt.wsError.value).toBe("Unauthorized");
    expect(rt.messages.value.map((m: any) => String(m.content ?? ""))).not.toContain(RECONNECT_BUSY_MESSAGE);
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.laneStatus.value).toBeNull();
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
    rt.laneStatus.value = { kind: "error", message: "stale error" };
    await settleUi(wrapper);

    controller.clearActiveChat();
    await settleUi(wrapper);

    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.laneStatus.value).toBeNull();
    expect(localStorage.getItem("ads.outbox.default.main")).toBeNull();
    expect(lastWs).toBeTruthy();
    expect(lastWs!.clearHistory).toHaveBeenCalledTimes(1);
    expect(lastWs!.clearHistory).toHaveBeenCalledWith({ scope: "lane", sourceChatSessionId: "main" });
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
    expect(localStorage.getItem("ads.outbox.default.planner")).toBeNull();
    wrapper.unmount();
  });
});
