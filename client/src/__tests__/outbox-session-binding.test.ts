import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import { createAppContext, type QueuedPrompt } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createOutboxStore, outboxStorageKey, type OutboxSnapshot } from "../app/outbox";

class TestChannel {
  static instances: TestChannel[] = [];
  onmessage?: (event: { data: { key: string; snapshot: OutboxSnapshot } }) => void;
  postMessage = vi.fn();
  close = vi.fn();
  constructor() { TestChannel.instances.push(this); }
}

const scopes: ReturnType<typeof effectScope>[] = [];
const empty: OutboxSnapshot = { pending: null, sent: [], queued: [], dismissed: [] };
const prompt = (id: string): QueuedPrompt => ({
  id, clientMessageId: id, text: id, images: [], createdAt: 1, deliveryStatus: "offline",
});
const snapshot = (id: string): OutboxSnapshot => ({ ...empty, queued: [prompt(id)] });
const read = (session = "project", chat = "a") => createOutboxStore().read(outboxStorageKey(session, chat));

function harness(projectSessionId = "project") {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx);
    const rt = ctx.getRuntime("project");
    rt.projectSessionId = projectSessionId;
    rt.chatSessionId = "a";
    const socket = { sendPrompt: vi.fn(() => true), send: vi.fn(() => true), close: vi.fn() };
    rt.ws = socket;
    chat.bindPromptOutbox(rt);
    return { ctx, chat, rt, socket, scope };
  })!;
}

function broadcast(chat: string, payload: OutboxSnapshot, session = "project") {
  const data = { key: outboxStorageKey(session, chat), snapshot: payload };
  for (const channel of TestChannel.instances) channel.onmessage?.({ data });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  TestChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", TestChannel);
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("outbox session binding ownership", () => {
  it("sends memory-only prompts without creating a fallback durable key", () => {
    const { chat, rt, socket } = harness("");
    rt.connected.value = true;
    chat.enqueuePrompt("Memory-only input", [], rt);
    expect(socket.sendPrompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Memory-only input" }), expect.any(String));
    expect(rt.messages.value.some((message) => message.role === "user" && message.content === "Memory-only input")).toBe(true);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("ads.outbox."))).toEqual([]);
  });

  it.each(["session", "account", "dispose"])("fences a memory-only async prompt when its %s changes", async (boundary) => {
    const { ctx, chat, rt, socket, scope } = harness("");
    let decode!: (value: Blob) => void;
    const decoded = new Promise<Blob>((resolve) => { decode = resolve; });
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => decoded });
    vi.stubGlobal("fetch", fetch);
    rt.connected.value = true;
    rt.queuedPrompts.value = [{ ...prompt("old-image"), images: [{ data: "data:image/png;base64,aW1hZ2U=", mime: "image/png" }] }];
    const sending = chat.flushQueuedPrompts(rt);
    await Promise.resolve();
    if (boundary === "session") rt.chatSessionId = "replacement";
    else if (boundary === "account") ctx.handleAuthRequired();
    else scope.stop();
    decode(new Blob(["image"], { type: "image/png" }));
    await sending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(socket.sendPrompt).not.toHaveBeenCalled();
    expect(rt.messages.value).toEqual([]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("ads.outbox."))).toEqual([]);
  });

  it.each(["chatSessionId", "projectSessionId"] as const)("rebinds %s without applying unknown old broadcasts or overwriting the destination", (field) => {
    const { chat, rt } = harness();
    rt.queuedPrompts.value = [prompt("old-local")];
    const nextSession = field === "projectSessionId" ? "next-project" : "project";
    const nextChat = field === "chatSessionId" ? "b" : "a";
    const nextKey = outboxStorageKey(nextSession, nextChat);
    localStorage.setItem(nextKey, JSON.stringify(snapshot("destination-input")));
    rt[field] = field === "projectSessionId" ? nextSession : nextChat;
    // The old sync watcher can fire before explicit binding at the control
    // barrier. It must not resolve its destination through mutable rt fields.
    rt.queuedPrompts.value = [...rt.queuedPrompts.value];
    broadcast("a", snapshot("unknown-late-old-input"));
    expect(read(nextSession, nextChat).queued.map((item) => item.clientMessageId)).toEqual(["destination-input"]);
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["old-local"]);

    chat.bindPromptOutbox(rt);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(read().queued).toEqual([]);
    expect(read().retired).toContain("old-local");
    expect(read(nextSession, nextChat).queued.map((item) => item.clientMessageId)).toEqual(["destination-input"]);
    broadcast("a", snapshot("another-unknown-old-input"));
    expect(rt.queuedPrompts.value).toEqual([]);
    broadcast(nextChat, snapshot("current-peer-input"), nextSession);
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["current-peer-input"]);
    chat.enqueuePrompt("current-local-input", [], rt);
    expect(read(nextSession, nextChat).queued.some((item) => item.text === "current-local-input")).toBe(true);
    expect(read().queued).toEqual([]);
  });

  it("has one watcher and subscription after repeated A/B/A switches", () => {
    const { chat, rt } = harness();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    for (const session of ["b", "a", "b", "a"]) {
      rt.chatSessionId = session;
      chat.bindPromptOutbox(rt);
      chat.bindPromptOutbox(rt);
    }
    setItem.mockClear();
    rt.queuedPrompts.value = [prompt("one-write")];
    expect(setItem.mock.calls.filter(([key]) => key === outboxStorageKey("project", "a"))).toHaveLength(1);
    broadcast("b", snapshot("not-current"));
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["one-write"]);
    broadcast("a", snapshot("current"));
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["current"]);
    // Peer snapshots never echo back through the queue watcher.
    expect(setItem.mock.calls.filter(([key]) => key === outboxStorageKey("project", "a"))).toHaveLength(1);
  });

  it("keeps project/lane subscribers isolated and suppressions scoped to their actual key", () => {
    const { ctx, chat, rt } = harness();
    const other = ctx.getAcopilotRuntime("project");
    other.projectSessionId = "project";
    other.chatSessionId = "acopilot";
    chat.bindPromptOutbox(other);
    rt.dismissedPromptIds!.add("same-id");
    rt.consumedPromptIds!.add("same-id");
    rt.retiredPromptIds!.add("same-id");
    rt.chatSessionId = "b";
    chat.bindPromptOutbox(rt);
    broadcast("b", snapshot("same-id"));
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["same-id"]);
    expect(other.queuedPrompts.value).toEqual([]);
    broadcast("acopilot", snapshot("advisor-input"));
    expect(other.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["advisor-input"]);
    expect(rt.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["same-id"]);
  });

  it("fences old account callbacks and writes even after reopening the same storage key", () => {
    const { ctx, chat, rt } = harness();
    const oldChannel = TestChannel.instances[0]!;
    const delayedCallback = oldChannel.onmessage!;
    ctx.handleAuthRequired();
    const next = ctx.getRuntime("project");
    next.projectSessionId = "project";
    next.chatSessionId = "a";
    chat.bindPromptOutbox(next);
    delayedCallback({ data: { key: outboxStorageKey("project", "a"), snapshot: snapshot("old-account") } });
    rt.queuedPrompts.value = [prompt("old-watcher")];
    chat.savePendingPrompt(rt, prompt("old-account-write"));
    expect(next.queuedPrompts.value).toEqual([]);
    expect(read().pending).toBeNull();
    expect(read().queued).toEqual([]);
    expect(oldChannel.close).toHaveBeenCalledOnce();
    broadcast("a", snapshot("new-account"));
    expect(next.queuedPrompts.value.map((item) => item.clientMessageId)).toEqual(["new-account"]);
  });

  it("does not recreate listeners or write storage after disposal", () => {
    const { chat, rt, scope } = harness();
    const channel = TestChannel.instances[0]!;
    const callback = channel.onmessage!;
    scope.stop();
    callback({ data: { key: outboxStorageKey("project", "a"), snapshot: snapshot("late") } });
    chat.savePendingPrompt(rt, prompt("late-save"));
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(read().pending).toBeNull();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(TestChannel.instances).toHaveLength(1);
  });

  it("does not start an attachment upload under a replacement account after deferred image decoding", async () => {
    const { ctx, chat, rt, socket } = harness();
    let decode!: (value: Blob) => void;
    const decoded = new Promise<Blob>((resolve) => { decode = resolve; });
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => decoded });
    vi.stubGlobal("fetch", fetch);
    rt.connected.value = true;
    rt.queuedPrompts.value = [{ ...prompt("old-image"), images: [{ data: "data:image/png;base64,aW1hZ2U=", mime: "image/png" }] }];
    const sending = chat.flushQueuedPrompts(rt);
    await Promise.resolve();
    ctx.handleAuthRequired();
    decode(new Blob(["image"], { type: "image/png" }));
    await sending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(socket.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["switch", "switch-back", "account", "upload-failure"])("fences late image preparation after %s before transcript/outbox/transport mutation", async (boundary) => {
    const { ctx, chat, rt, socket } = harness();
    let finish!: (value: unknown) => void;
    let fail!: (reason: Error) => void;
    const upload = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) })
      .mockReturnValueOnce(upload);
    vi.stubGlobal("fetch", fetch);
    rt.connected.value = true;
    rt.queuedPrompts.value = [{ ...prompt("old-image"), images: [{ data: "data:image/png;base64,aW1hZ2U=", mime: "image/png" }] }];
    const sending = chat.flushQueuedPrompts(rt);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    if (boundary === "account") ctx.handleAuthRequired();
    else {
      rt.chatSessionId = "b";
      chat.bindPromptOutbox(rt);
      if (boundary === "switch-back") {
        rt.chatSessionId = "a";
        chat.bindPromptOutbox(rt);
      }
    }
    const currentMessages = [{ id: "current", role: "assistant" as const, kind: "text" as const, content: "Current transcript" }];
    rt.messages.value = currentMessages;
    const committedMessages = rt.messages.value;
    rt.connected.value = true;
    rt.busy.value = true;
    rt.laneStatus.value = { kind: "info", message: "Current status" };
    if (boundary === "upload-failure") fail(new Error("Upload failed"));
    else finish({ ok: true, text: async () => JSON.stringify({ id: "attachment", url: "/image" }) });
    await sending;

    expect(socket.sendPrompt).not.toHaveBeenCalled();
    expect(rt.messages.value).toBe(committedMessages);
    expect(rt.busy.value).toBe(true);
    expect(rt.connected.value).toBe(true);
    expect(rt.laneStatus.value?.message).toBe("Current status");
    expect(read("project", rt.chatSessionId).sent).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
  });
});
