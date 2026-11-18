import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";

import { createAppController } from "../app/controller";
import MainChat from "../components/MainChat.vue";
import * as markdown from "../lib/markdown";
import { outboxStorageKey } from "../app/outbox";

const state = vi.hoisted(() => ({ sockets: [] as any[], get: vi.fn() }));
vi.mock("../api/client", () => ({ ApiClient: class { get = state.get; } }));
vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (event: unknown) => void;
    onMessage?: (message: unknown) => void;
    send = vi.fn();
    sendPrompt = vi.fn(() => true);
    close = vi.fn();
    connect = vi.fn();
    constructor(public options: unknown) { state.sockets.push(this); }
  }
  return {
    AdsWebSocket,
    getProjectWebSocketLane: (options: {
      sessionId: string;
      lane: "actions" | "acopilot";
      configs: Record<"actions" | "acopilot", {
        chatSessionId: string;
        resume?: { afterSeq: number; laneGeneration: number };
      }>;
    }) => new AdsWebSocket({
      sessionId: options.sessionId,
      chatSessionId: options.configs[options.lane].chatSessionId,
      lane: options.lane,
      resume: options.configs[options.lane].resume,
    }),
  };
});

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  state.sockets.length = 0;
  state.get.mockReset();
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  localStorage.clear();
  sessionStorage.clear();
});

async function harness(lane: "actions" | "acopilot" = "actions") {
  let controller!: ReturnType<typeof createAppController>;
  const wrapper = mount(defineComponent({
    components: { MainChat },
    setup() {
      controller = createAppController();
      return { rt: lane === "acopilot" ? controller.activeAcopilotRuntime : controller.activeRuntime };
    },
    template: `<MainChat
      :messages="rt.messages.value"
      :viewport="rt.transcriptViewport.value"
      :transcript-scope-key="rt.transcriptScopeKey.value"
      :transcript-authoritative="rt.transcriptAuthoritative.value"
      :transcript-authoritative-seq="rt.transcriptAuthoritativeSeq.value"
      :transcript-reset-seq="rt.transcriptResetSeq.value"
      :transcript-align-seq="rt.transcriptAlignSeq.value"
      :queued-prompts="[]"
      :pending-images="[]"
      :connected="rt.connected.value"
      :busy="rt.busy.value"
      @update:viewport="rt.transcriptViewport.value = $event"
      read-only
    />`,
  }));
  wrappers.push(wrapper);
  controller.loggedIn.value = true;
  controller.transcriptCache.setOwner("user-1");
  const connect = lane === "acopilot" ? controller.connectAcopilotWs : controller.connectWs;
  await connect("default");
  const socket = latestSocket(lane);
  socket.onOpen();
  const rt = lane === "acopilot" ? controller.getAcopilotRuntime("default") : controller.getRuntime("default");
  return { controller, wrapper, rt, socket, connect, lane };
}

function latestSocket(lane: "actions" | "acopilot") {
  return [...state.sockets].reverse().find((socket) => socket.options.lane === lane)!;
}

async function bootstrap(info: Awaited<ReturnType<typeof harness>>) {
  expect(info.rt.transcriptAuthoritative.value).toBe(false);
  info.socket.onMessage({
    type: "welcome", historyMode: "snapshot", bootstrapHistory: true,
    latestSeq: 10, laneGeneration: 1, inFlight: false, chatSessionId: info.rt.chatSessionId,
  });
  expect(info.rt.transcriptAuthoritative.value).toBe(false);
  info.socket.onMessage({ type: "history", items: [
    { role: "user", text: "Question", ts: 1, kind: "client_message_id:question-1" },
    { role: "ai", text: "**Cached answer**", ts: 2 },
  ] });
  await flushPromises();
  expect(info.rt.transcriptCursor).toBe(10);
  expect(info.rt.transcriptReady).toBe(true);
  expect(info.rt.transcriptAuthoritative.value).toBe(true);
  expect(info.rt.transcriptAuthoritativeSeq.value).toBe(1);
}

async function reconnect(info: Awaited<ReturnType<typeof harness>>, latestSeq = 10) {
  const authoritativeSeq = info.rt.transcriptAuthoritativeSeq.value;
  info.socket.onClose({ code: 1006 });
  await info.connect("default");
  expect(info.rt.transcriptAuthoritative.value).toBe(false);
  const socket = latestSocket(info.lane);
  expect(socket.options.resume).toEqual({ afterSeq: 10, laneGeneration: 1 });
  socket.onOpen();
  socket.onMessage({ type: "welcome", historyMode: latestSeq > 10 ? "catch_up" : "resume", bootstrapHistory: false, latestSeq, laneGeneration: 1, inFlight: false });
  await flushPromises();
  expect(info.rt.transcriptAuthoritative.value).toBe(true);
  expect(info.rt.transcriptAuthoritativeSeq.value).toBe(authoritativeSeq + 1);
  return socket;
}

describe("local-first reconnect integration", () => {
  it("restores the destination reading position across a real A/B/A session switch", async () => {
    const info = await harness();
    await bootstrap(info);
    const messagesA = [...info.rt.messages.value];
    const chat = info.wrapper.get(".chat").element as HTMLElement;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
    });
    info.rt.transcriptViewport.value = {
      following: false, firstLoadedId: messagesA[0]!.id, anchorId: "missing-anchor",
      anchorOffset: 0, scrollTop: 430, userControlled: true,
      scopeKey: info.rt.transcriptScopeKey.value, tailMessageId: messagesA.at(-1)!.id,
    };
    info.controller.transcriptCache.flush();
    info.socket.onMessage({
      type: "welcome", chatSessionId: "session-b", historyMode: "snapshot",
      bootstrapHistory: true, latestSeq: 20, laneGeneration: 1, inFlight: false,
    });
    info.socket.onMessage({ type: "history", items: [{ role: "ai", text: "Session B answer", ts: 3 }] });
    await flushPromises();
    expect(info.wrapper.text()).toContain("Session B answer");
    expect(chat.scrollTop).toBe(2000);

    info.socket.onMessage({
      type: "welcome", chatSessionId: "main", historyMode: "snapshot",
      bootstrapHistory: true, latestSeq: 10, laneGeneration: 1, inFlight: false,
    });
    await flushPromises();
    expect(info.rt.messages.value).toEqual(messagesA);
    expect(chat.scrollTop).toBe(430);
    info.socket.onMessage({ type: "history", items: [
      { role: "user", text: "Question", ts: 1, kind: "client_message_id:question-1" },
      { role: "ai", text: "**Cached answer**", ts: 2 },
    ] });
    await flushPromises();
    expect(chat.scrollTop).toBe(430);
    expect(info.wrapper.text()).not.toContain("Session B answer");
  });

  it("fences old outbox watchers and pending input at an authentication boundary", async () => {
    const info = await harness();
    await bootstrap(info);
    info.rt.connected.value = false;
    info.controller.enqueuePrompt("Old account input", [], info.rt);
    const key = outboxStorageKey(info.rt.projectSessionId, info.rt.chatSessionId);
    expect(localStorage.getItem(key)).toContain("Old account input");
    const oldPrompts = info.rt.queuedPrompts.value;
    info.controller.handleAuthRequired();
    expect(localStorage.getItem(key)).toBeNull();
    info.rt.queuedPrompts.value = oldPrompts;
    info.controller.savePendingPrompt(info.rt, oldPrompts[0]!);
    expect(localStorage.getItem(key)).toBeNull();
    const replacement = info.controller.getRuntime("default");
    replacement.projectSessionId = info.rt.projectSessionId;
    info.controller.restorePendingPrompt(replacement);
    expect(replacement.queuedPrompts.value).toEqual([]);
  });

  it("does not reuse a detached sessionStorage cursor without its transcript", async () => {
    sessionStorage.setItem("ads.syncCursor.default.main", '{"lastSeq":999}');
    const info = await harness();
    expect(info.socket.options.resume).toBeUndefined();
    await bootstrap(info);
    expect(state.get).not.toHaveBeenCalled();
    expect(info.rt.messages.value.map((message) => message.content)).toEqual(["Question", "**Cached answer**"]);
  });

  it("preserves message objects, DOM, Markdown and scroll on an unchanged reconnect", async () => {
    const render = vi.spyOn(markdown, "renderMarkdownToHtml");
    const info = await harness();
    await bootstrap(info);
    const messages = info.rt.messages.value;
    const row = info.wrapper.find('.msg[data-role="assistant"]').element;
    const htmlNode = info.wrapper.find(".md strong").element;
    const parsed = render.mock.calls.length;
    const chat = info.wrapper.find(".chat").element as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(chat, "clientHeight", { configurable: true, value: 500 });
    await info.wrapper.find(".chat").trigger("wheel", { deltaY: -80 });
    chat.scrollTop = 430;
    await info.wrapper.find(".chat").trigger("scroll");
    await reconnect(info);
    expect(info.rt.messages.value).toBe(messages);
    expect(info.wrapper.find('.msg[data-role="assistant"]').element).toBe(row);
    expect(info.wrapper.find(".md strong").element).toBe(htmlNode);
    expect(render).toHaveBeenCalledTimes(parsed);
    expect(chat.scrollTop).toBe(430);
    expect(state.get).not.toHaveBeenCalled();
  });

  it("fetches only the missing range and appends it without reparsing old Markdown", async () => {
    const render = vi.spyOn(markdown, "renderMarkdownToHtml");
    const info = await harness();
    await bootstrap(info);
    const oldMessages = [...info.rt.messages.value];
    const row = info.wrapper.find('.msg[data-role="assistant"]').element;
    state.get.mockResolvedValue({
      events: [
        { seq: 11, type: "user", ts: 3, payload: { type: "user", clientMessageId: "question-2", text: "New question" } },
        { seq: 12, type: "result", ts: 4, payload: { type: "result", ok: true, output: "New answer" } },
      ], latestSeq: 12, truncated: false, hasMore: false,
    });
    await reconnect(info, 12);
    expect(state.get).toHaveBeenCalledTimes(1);
    expect(state.get.mock.calls[0][0]).toContain("afterSeq=10");
    expect(info.rt.messages.value.map((message) => message.content)).toEqual(["Question", "**Cached answer**", "New question", "New answer"]);
    expect(info.rt.messages.value[0]).toBe(oldMessages[0]);
    expect(info.rt.messages.value[1]).toBe(oldMessages[1]);
    expect(info.wrapper.find('.msg[data-role="assistant"]').element).toBe(row);
    expect(render.mock.calls.filter(([content]) => content === "**Cached answer**")).toHaveLength(1);
    expect(info.rt.transcriptCursor).toBe(12);
  });

  it("publishes resume authority only after the advertised WebSocket replay boundary", async () => {
    const info = await harness();
    await bootstrap(info);
    info.socket.onClose({ code: 1006 });
    await info.connect("default");
    const socket = latestSocket(info.lane);
    socket.onOpen();
    socket.onMessage({
      type: "welcome", historyMode: "resume", bootstrapHistory: false,
      latestSeq: 12, laneGeneration: 1, inFlight: false,
    });
    await flushPromises();
    expect(info.rt.transcriptAuthoritative.value).toBe(false);
    expect(info.rt.transcriptAuthoritativeSeq.value).toBe(1);

    socket.onMessage({ type: "user", seq: 11, clientMessageId: "question-2", text: "New question", ts: 3 });
    await flushPromises();
    expect(info.rt.transcriptAuthoritative.value).toBe(false);
    socket.onMessage({ type: "result", seq: 12, ok: true, output: "New answer", ts: 4 });
    await flushPromises();
    expect(info.rt.transcriptAuthoritative.value).toBe(true);
    expect(info.rt.transcriptAuthoritativeSeq.value).toBe(2);
    expect(info.rt.transcriptCursor).toBe(12);
    expect(info.rt.messages.value.map((message) => message.content)).toEqual([
      "Question", "**Cached answer**", "New question", "New answer",
    ]);
    expect(state.get).not.toHaveBeenCalled();

    socket.onMessage({ type: "result", seq: 12, ok: true, output: "Duplicate answer", ts: 4 });
    await flushPromises();
    expect(info.rt.transcriptAuthoritativeSeq.value).toBe(2);
    expect(info.wrapper.text()).not.toContain("Duplicate answer");
  });

  it("uses the atomic cold cache cursor, not a newer detached cursor", async () => {
    const info = await harness();
    await bootstrap(info);
    info.controller.transcriptCache.flush();
    info.wrapper.unmount();
    wrappers.splice(wrappers.indexOf(info.wrapper), 1);
    sessionStorage.setItem("ads.syncCursor.default.main", '{"lastSeq":999}');
    const restored = await harness();
    expect(restored.wrapper.text()).toContain("Cached answer");
    expect(restored.socket.options.resume).toEqual({ afterSeq: 10, laneGeneration: 1 });
  });

  it("still publishes raw streaming mutations at the frame boundary and persists their partial text", async () => {
    const info = await harness();
    await bootstrap(info);
    info.socket.onMessage({ type: "user", seq: 11, clientMessageId: "stream-prompt", text: "Stream now", ts: 3 });
    info.socket.onMessage({ type: "in_flight", seq: 12, inFlight: true });
    info.socket.onMessage({ type: "delta", afterSeq: 12, delta: "First streaming chunk" });
    await vi.waitFor(() => expect(info.wrapper.text()).toContain("First streaming chunk"));
    info.socket.onMessage({ type: "delta", afterSeq: 12, delta: " and the second chunk" });
    await vi.waitFor(() => expect(info.wrapper.text()).toContain("First streaming chunk and the second chunk"));
    info.controller.transcriptCache.flush();
    const cached = Object.keys(localStorage).filter((key) => key.startsWith("ads.transcript.v1."))
      .map((key) => JSON.parse(localStorage.getItem(key)!));
    expect(cached.some((entry) => entry.complete === false && entry.messages.some((message: any) => message.content === "First streaming chunk and the second chunk"))).toBe(true);
  });

  it("replaces a rejected cache at the snapshot barrier, not at welcome", async () => {
    const info = await harness();
    await bootstrap(info);
    await info.controller.connectWs("default");
    const socket = latestSocket(info.lane);
    socket.onOpen();
    socket.onMessage({ type: "welcome", historyMode: "snapshot", bootstrapHistory: true, latestSeq: 2, laneGeneration: 1, inFlight: false });
    expect(info.wrapper.text()).toContain("Cached answer");
    socket.onMessage({ type: "history", items: [{ role: "ai", text: "Authoritative answer", ts: 5 }] });
    await flushPromises();
    expect(info.rt.messages.value.map((message) => message.content)).toEqual(["Authoritative answer"]);
    expect(info.rt.transcriptCursor).toBe(2);
    expect(info.rt.transcriptReady).toBe(true);
    expect(state.get).not.toHaveBeenCalled();
  });

  it("releases queued prompts after a resume acknowledgement without waiting for history", async () => {
    const info = await harness();
    await bootstrap(info);
    info.rt.queuedPrompts.value = [{ id: "queued-1", clientMessageId: "queued-1", text: "Continue", images: [], createdAt: 10 }];
    const socket = await reconnect(info);
    expect(info.rt.awaitingBootstrapHistory).toBe(false);
    expect(socket.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps a newly sent queued prompt after an empty authoritative bootstrap", async () => {
    const info = await harness();
    info.rt.queuedPrompts.value = [{ id: "queued-1", clientMessageId: "queued-1", text: "Continue", images: [], createdAt: 10 }];
    info.socket.onMessage({ type: "welcome", historyMode: "snapshot", bootstrapHistory: false, latestSeq: 0, laneGeneration: 1, inFlight: false, contextMode: "fresh" });
    await flushPromises();
    expect(info.socket.sendPrompt).toHaveBeenCalledTimes(1);
    expect(info.rt.messages.value.some((message) => message.content === "Continue")).toBe(true);
  });

  it("commits an in-band reset baseline while rejecting a pre-reset catch-up response", async () => {
    const info = await harness();
    await bootstrap(info);
    let resolve!: (response: unknown) => void;
    state.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    info.socket.onMessage({ type: "welcome", historyMode: "resume", latestSeq: 12, laneGeneration: 1, inFlight: false });
    info.socket.onMessage({ type: "session_reset", scope: "lane", sourceChatSessionId: "main", laneGeneration: 2 });
    info.socket.onMessage({ type: "welcome", historyMode: "snapshot", bootstrapHistory: true, latestSeq: 0, laneGeneration: 2, inFlight: false });
    info.socket.onMessage({ type: "history", items: [{ role: "ai", text: "Generation two", ts: 3 }] });
    await flushPromises();
    resolve({ events: [{ seq: 12, type: "result", payload: { type: "result", ok: true, output: "Stale reply" } }], latestSeq: 12, truncated: false, hasMore: false });
    await flushPromises();
    expect(info.rt.messages.value.map((message) => message.content)).toEqual(["Generation two"]);
    expect(info.rt.transcriptReady).toBe(true);
    expect(info.rt.transcriptCursor).toBe(0);
    expect(info.rt.laneGeneration).toBe(2);
  });

  it.each(["actions", "acopilot"] as const)("retires only the old generation's reading control in the %s lane", async (lane) => {
    const info = await harness(lane);
    await bootstrap(info);
    const scope = info.rt.transcriptScopeKey.value;
    const chat = info.wrapper.get(".chat").element as HTMLElement;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
    });
    await info.wrapper.get(".chat").trigger("wheel", { deltaY: -80 });
    chat.scrollTop = 430;
    await info.wrapper.get(".chat").trigger("scroll");
    info.socket.onClose({ code: 1006 });
    await info.connect("default");
    const socket = latestSocket(info.lane);
    socket.onOpen();
    socket.onMessage({
      type: "welcome", historyMode: "snapshot", bootstrapHistory: true,
      latestSeq: 20, laneGeneration: 2, inFlight: false, chatSessionId: info.rt.chatSessionId,
    });
    await flushPromises();
    expect(info.rt.transcriptResetSeq.value).toBe(1);
    expect(info.rt.transcriptScopeKey.value).toBe(scope);
    socket.onMessage({ type: "history", items: [
      { role: "user", text: "New generation question", ts: 3, kind: "client_message_id:question-2" },
      { role: "ai", text: "New generation answer", ts: 4 },
    ] });
    await flushPromises();
    expect(chat.scrollTop).toBe(2000);

    await info.wrapper.get(".chat").trigger("wheel", { deltaY: -80 });
    chat.scrollTop = 120;
    await info.wrapper.get(".chat").trigger("scroll");
    socket.onMessage({ type: "welcome", historyMode: "resume", latestSeq: 20, laneGeneration: 2, inFlight: false });
    await flushPromises();
    expect(info.rt.transcriptResetSeq.value).toBe(1);
    expect(chat.scrollTop).toBe(120);
  });

  it("can rebuild a cold baseline after a server generation rollback", async () => {
    const info = await harness();
    await bootstrap(info);
    info.rt.laneGeneration = 5;
    await info.connect("default");
    const socket = latestSocket(info.lane);
    socket.onOpen();
    socket.onMessage({ type: "welcome", historyMode: "snapshot", bootstrapHistory: true, latestSeq: 1, laneGeneration: 1, inFlight: false });
    socket.onMessage({ type: "history", items: [{ role: "ai", text: "Restored database", ts: 3 }] });
    await flushPromises();
    expect(info.rt.messages.value.map((message) => message.content)).toEqual(["Restored database"]);
    expect(info.rt.laneGeneration).toBe(1);
    expect(info.rt.transcriptCursor).toBe(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
});
