import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";

import { createAppController } from "../app/controller";
import MainChat from "../components/MainChat.vue";
import * as markdown from "../lib/markdown";
import { outboxStorageKey } from "../app/outbox";

const state = vi.hoisted(() => ({ sockets: [] as any[], get: vi.fn() }));
vi.mock("../api/client", () => ({ ApiClient: class { get = state.get; } }));
vi.mock("../api/ws", () => ({ AdsWebSocket: class {
  onOpen?: () => void;
  onClose?: (event: unknown) => void;
  onMessage?: (message: unknown) => void;
  send = vi.fn();
  sendPrompt = vi.fn(() => true);
  close = vi.fn();
  connect = vi.fn();
  constructor(public options: unknown) { state.sockets.push(this); }
} }));

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

async function harness() {
  let controller!: ReturnType<typeof createAppController>;
  const wrapper = mount(defineComponent({
    components: { MainChat },
    setup() {
      controller = createAppController();
      return { rt: controller.activeRuntime };
    },
    template: '<MainChat :messages="rt.messages.value" :queued-prompts="[]" :pending-images="[]" :connected="rt.connected.value" :busy="rt.busy.value" read-only />',
  }));
  wrappers.push(wrapper);
  controller.loggedIn.value = true;
  controller.transcriptCache.setOwner("user-1");
  await controller.connectWs("default");
  const socket = state.sockets.at(-1)!;
  socket.onOpen();
  return { controller, wrapper, rt: controller.getRuntime("default"), socket };
}

async function bootstrap(info: Awaited<ReturnType<typeof harness>>) {
  info.socket.onMessage({
    type: "welcome", historyMode: "snapshot", bootstrapHistory: true,
    latestSeq: 10, laneGeneration: 1, inFlight: false, chatSessionId: "main",
  });
  info.socket.onMessage({ type: "history", items: [
    { role: "user", text: "Question", ts: 1, kind: "client_message_id:question-1" },
    { role: "ai", text: "**Cached answer**", ts: 2 },
  ] });
  await flushPromises();
  expect(info.rt.transcriptCursor).toBe(10);
  expect(info.rt.transcriptReady).toBe(true);
}

async function reconnect(info: Awaited<ReturnType<typeof harness>>, latestSeq = 10) {
  info.socket.onClose({ code: 1006 });
  await info.controller.connectWs("default");
  const socket = state.sockets.at(-1)!;
  expect(socket.options.resume).toEqual({ afterSeq: 10, laneGeneration: 1 });
  socket.onOpen();
  socket.onMessage({ type: "welcome", historyMode: "resume", bootstrapHistory: false, latestSeq, laneGeneration: 1, inFlight: false });
  await flushPromises();
  return socket;
}

describe("local-first reconnect integration", () => {
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
    const socket = state.sockets.at(-1)!;
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

  it("can rebuild a cold baseline after a server generation rollback", async () => {
    const info = await harness();
    await bootstrap(info);
    info.rt.laneGeneration = 5;
    await info.controller.connectWs("default");
    const socket = state.sockets.at(-1)!;
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
