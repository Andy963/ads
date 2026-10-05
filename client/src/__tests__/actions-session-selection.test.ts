import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

import { createAppContext, type ProjectRuntime } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createWebSocketActions } from "../app/projectsWs/webSocketActions";
import { createOutboxStore, legacyPendingPromptStorageKey, outboxStorageKey } from "../app/outbox";
import { readCachedTranscript, transcriptCacheKey } from "../app/transcriptCache";
import { readAppNavigationState } from "../lib/preferencesStore";

vi.mock("../api/ws", () => ({
  AdsWebSocket: class {
    onOpen?: () => void;
    onMessage?: (message: unknown) => void;
    onClose?: (event: { code: number }) => void;
    constructor(public options: { chatSessionId: string; resume?: { afterSeq: number; laneGeneration: number } }) {}
    connect = vi.fn();
    close = vi.fn();
    send = vi.fn(() => true);
    promptFrames = vi.fn((..._args: unknown[]) => true);
    sendPrompt = (...args: unknown[]) => this.promptFrames(...args);
    switchChatSession = vi.fn(() => true);
    clearHistory = vi.fn();
  },
}));

type TestSocket = {
  options: { chatSessionId: string; resume?: { afterSeq: number; laneGeneration: number } };
  onOpen: () => void;
  onMessage: (message: unknown) => void;
  onClose: (event: { code: number }) => void;
  send: ReturnType<typeof vi.fn>;
  promptFrames: ReturnType<typeof vi.fn>;
  switchChatSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const cleanups: Array<() => void> = [];

async function setup() {
  const scope = effectScope();
  const harness = scope.run(() => {
    const ctx = createAppContext();
    ctx.loggedIn.value = true;
    ctx.transcriptCache.setOwner("user-521");
    ctx.projects.value = [{
      id: "p1", sessionId: "p1", name: "Project", path: "/workspace/project",
      chatSessionId: "old-chat", initialized: true, createdAt: 1, updatedAt: 1,
    }];
    ctx.activeProjectId.value = "p1";
    vi.spyOn(ctx.api, "get").mockResolvedValue({ ok: false });
    const patch = vi.spyOn(ctx.api, "patch").mockResolvedValue({ success: true });
    const chat = createChatActions(ctx);
    const deps = { activateProject: async (id: string) => ws.connectWs(id) };
    const projects = createProjectActions({ ...ctx, ...chat }, deps);
    const ws = createWebSocketActions({ ...ctx, ...chat }, projects);
    return { ctx, chat, projects, ws, patch };
  })!;
  cleanups.push(() => {
    harness.ws.closeAllConnections();
    harness.ctx.transcriptCache.dispose();
    scope.stop();
  });
  await harness.ws.connectWs("p1");
  const rt = harness.ctx.getRuntime("p1");
  const socket = rt.ws as TestSocket;
  socket.onOpen();
  return { ...harness, rt, socket };
}

function welcome(socket: TestSocket, chatSessionId: string, latestSeq = 2, laneGeneration = 1) {
  socket.onMessage({
    type: "welcome", chatSessionId, latestSeq, laneGeneration,
    historyMode: "snapshot", bootstrapHistory: true, inFlight: false, contextMode: "history_injection",
  });
}

async function history(socket: TestSocket, text: string, afterSeq = 2) {
  socket.onMessage({ type: "history", afterSeq, items: [{ role: "ai", text, ts: 1 }] });
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function seedInputs(rt: ProjectRuntime, chat: ReturnType<typeof createChatActions>) {
  const prompt = { id: "old-q", clientMessageId: "old-input", text: "Do not replay", images: [], createdAt: 1 };
  rt.queuedPrompts.value = [{ ...prompt, deliveryStatus: "offline" }];
  rt.pendingAckClientMessageId = prompt.clientMessageId;
  chat.savePendingPrompt(rt, prompt);
  const key = outboxStorageKey("p1", "old-chat");
  localStorage.setItem(key, JSON.stringify({
    pending: prompt, sent: [{ ...prompt, clientMessageId: "old-sent" }], queued: [prompt], dismissed: [],
  }));
  sessionStorage.setItem(legacyPendingPromptStorageKey("p1", "old-chat"), JSON.stringify(prompt));
  sessionStorage.setItem("ads.syncCursor.p1.old-chat", JSON.stringify({ lastSeq: 90 }));
  rt.transcriptCursor = 90;
  rt.transcriptReady = true;
  return key;
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("server-authoritative Actions chat selection", () => {
  it("rebinds a peer welcome, retires old inputs/cursors, and persists only the local selection", async () => {
    const { ctx, chat, rt, socket, patch } = await setup();
    welcome(socket, "old-chat", 90, 8);
    await history(socket, "Old transcript", 90);
    const key = seedInputs(rt, chat);
    rt.composerDraft.value = "Unsent draft";

    welcome(socket, "peer-chat", 2, 1);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(createOutboxStore().read(key)).toMatchObject({ pending: null, sent: [], queued: [] });
    expect(sessionStorage.getItem("ads.syncCursor.p1.old-chat")).toBeNull();
    expect(sessionStorage.getItem(legacyPendingPromptStorageKey("p1", "old-chat"))).toBeNull();
    expect(rt.transcriptCursor).toBe(0);
    expect(rt.messages.value).toEqual([]);
    expect(ctx.getRuntime("p1")).toBe(rt);
    expect(ctx.activeRuntime.value.chatSessionId).toBe("peer-chat");
    expect(readAppNavigationState().projects).toEqual(expect.arrayContaining([expect.objectContaining({ chatSessionId: "peer-chat" })]));
    expect(patch).not.toHaveBeenCalled();
    expect(socket.switchChatSession).not.toHaveBeenCalled();

    await history(socket, "Peer transcript");
    expect(rt.messages.value.map((message) => message.content)).toEqual(["Peer transcript"]);
    expect(rt.composerDraft.value).toBe("Unsent draft");
    ctx.transcriptCache.flush();
    expect(readCachedTranscript(transcriptCacheKey("user-521", {
      projectId: "p1", sessionId: "p1", chatSessionId: "peer-chat", workspace: "/workspace/project",
    }))).toMatchObject({ cursor: 2, generation: 1, messages: [{ content: "Peer transcript" }] });
    await chat.flushQueuedPrompts(rt);
    expect(socket.promptFrames).not.toHaveBeenCalled();
  });

  it("uses canonical selection and its cursor on the next reconnect without affecting Acopilot", async () => {
    const { ctx, rt, ws, socket } = await setup();
    await ws.connectAcopilotWs("p1");
    const acopilot = ctx.getAcopilotRuntime("p1");
    const acopilotSession = acopilot.chatSessionId;
    acopilot.messages.value = [{ id: "advisor", role: "assistant", kind: "text", content: "Advisor transcript" }];
    welcome(socket, "canonical-chat", 3);
    await history(socket, "Canonical transcript", 3);
    await ws.connectWs("p1");
    const next = rt.ws as TestSocket;
    expect(next.options).toMatchObject({ chatSessionId: "canonical-chat", resume: { afterSeq: 3, laneGeneration: 1 } });
    expect(ctx.getAcopilotRuntime("p1").chatSessionId).toBe(acopilotSession);
    expect(acopilot.messages.value[0]?.content).toBe("Advisor transcript");
  });

  it("waits for the canonical welcome after a session_changed rejection instead of flushing stale input", async () => {
    const { chat, rt, socket } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    seedInputs(rt, chat);
    socket.onMessage({ type: "error", code: "session_changed", clientMessageId: "old-input", message: "Session changed" });
    socket.onMessage({ type: "result", ok: false, output: "Aborted old turn" });
    await chat.flushQueuedPrompts(rt);
    expect(socket.promptFrames).not.toHaveBeenCalled();
    expect(rt.syncInProgress).toBe(true);
    welcome(socket, "peer-chat");
    await history(socket, "Peer transcript");
    expect(rt.syncInProgress).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
    expect(socket.promptFrames).not.toHaveBeenCalled();
  });

  it("releases a same-session selection barrier after A/B/A resolves to an authoritative A bootstrap", async () => {
    const { ctx, chat, rt, socket, patch } = await setup();
    welcome(socket, "old-chat", 90);
    await history(socket, "Original A transcript", 90);
    const key = seedInputs(rt, chat);

    // A held command delays the peer rebind to B. Input is rejected, but the
    // authoritative selection returns to A before that barrier drains.
    socket.onMessage({
      type: "error", code: "session_changed", chat_session_id: "old-chat",
      clientMessageId: "old-input", message: "Session selection is changing",
    });
    expect(rt.syncInProgress).toBe(true);
    expect(rt.inputLocked.value).toBe(true);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.transcriptCursor).toBe(0);
    expect(sessionStorage.getItem("ads.syncCursor.p1.old-chat")).toBeNull();
    expect(createOutboxStore().read(key)).toMatchObject({ pending: null, sent: [], queued: [] });
    expect(createOutboxStore().read(key).retired).toEqual(expect.arrayContaining(["old-input", "old-sent"]));
    socket.onMessage({ type: "result", ok: false, output: "Stale held command result" });
    await chat.flushQueuedPrompts(rt);
    expect(socket.promptFrames).not.toHaveBeenCalled();

    // Neither identity nor generation nor cursor advances. The same-session
    // welcome/history must still release the selection barrier.
    welcome(socket, "old-chat", 90);
    expect(rt.syncInProgress).toBe(true);
    chat.enqueuePrompt("Fresh input after no-op selection", [], rt);
    const freshId = rt.queuedPrompts.value[0]!.clientMessageId;
    expect(socket.promptFrames).not.toHaveBeenCalled();
    await history(socket, "Authoritative A transcript", 90);
    expect(rt.syncInProgress).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
    expect(rt.awaitingBootstrapHistory).toBe(false);
    expect(rt.transcriptCursor).toBe(90);
    expect(ctx.getRuntime("p1").chatSessionId).toBe("old-chat");
    expect(socket.promptFrames).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Fresh input after no-op selection" }), freshId,
    );
    expect(rt.messages.value.some((message) => message.content === "Stale held command result")).toBe(false);

    socket.onMessage({ type: "ack", client_message_id: freshId });
    socket.onMessage({ type: "user", seq: 91, clientMessageId: freshId, text: "Fresh input after no-op selection" });
    socket.onMessage({ type: "result", seq: 92, clientMessageId: freshId, ok: true, output: "Fresh reply on A" });
    await nextTick();
    expect(rt.messages.value.some((message) => message.content === "Fresh reply on A")).toBe(true);
    expect(rt.transcriptCursor).toBe(92);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(createOutboxStore().read(key)).toMatchObject({ pending: null, sent: [], queued: [] });
    expect(socket.promptFrames).toHaveBeenCalledTimes(1);
    expect(socket.switchChatSession).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it.each(["prompt", "command"])("ignores a late old-session %s rejection without poisoning the new chat", async (type) => {
    const { chat, rt, socket } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    seedInputs(rt, chat);
    welcome(socket, "peer-chat");
    await history(socket, "Peer transcript");
    rt.queuedPrompts.value = [{ id: "new", clientMessageId: "new-input", text: "New input", images: [], createdAt: 2 }];
    socket.onMessage({
      type: "error", code: "session_changed", chat_session_id: "old-chat", message: "Old session rejected",
      ...(type === "prompt" ? { clientMessageId: "old-input" } : {}),
    });
    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["new-input"]);
    expect(rt.messages.value.map((message) => message.content)).toEqual(["Peer transcript"]);
    expect(rt.syncInProgress).toBe(false);
    expect(rt.inputLocked.value).toBe(false);
  });

  it.each([
    [true, "before-history"], [true, "after-history"],
    [false, "before-history"], [false, "after-history"],
  ] as const)("fences truncated HTTP catch-up across same-session snapshot (rejection=%s, response=%s)", async (rejection, responseOrder) => {
    const { ctx, rt, socket } = await setup();
    welcome(socket, "old-chat", 50);
    await history(socket, "Original A transcript", 50);
    let finish!: (value: unknown) => void;
    const get = vi.mocked(ctx.api.get).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    get.mockClear();
    socket.onMessage({
      type: "welcome", chatSessionId: "old-chat", laneGeneration: 1,
      latestSeq: 80, historyMode: "resume", bootstrapHistory: true, inFlight: false,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toContain("afterSeq=50");
    expect(rt.syncInProgress).toBe(true);

    if (rejection) {
      socket.onMessage({ type: "error", code: "session_changed", chat_session_id: "old-chat", message: "Selection changed" });
    }
    // Selection returned A -> B -> A without changing A's lane generation.
    // A new snapshot is authoritative even if no local input was rejected.
    welcome(socket, "old-chat", 100);
    const staleResponse = {
      events: [], latestSeq: 80, truncated: true, hasMore: false, laneGeneration: 1,
      snapshot: { type: "history", items: [{ role: "ai", text: "Stale HTTP transcript at 80", ts: 1 }] },
    };
    if (responseOrder === "before-history") {
      finish(staleResponse);
      await nextTick();
      await Promise.resolve();
    }
    await history(socket, "Authoritative A transcript at 100", 100);
    if (responseOrder === "after-history") finish(staleResponse);
    await nextTick();
    await Promise.resolve();
    await nextTick();

    expect(rt.messages.value.map((message) => message.content)).toEqual(["Authoritative A transcript at 100"]);
    expect(rt.transcriptCursor).toBe(100);
    expect(rt.transcriptReady).toBe(true);
    expect(rt.syncInProgress).toBe(false);
    expect(rt.needsChatSync).toBe(false);
    expect(rt.apiNotice.value).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("ads.syncCursor.p1.old-chat")!).lastSeq).toBe(100);
    ctx.transcriptCache.flush();
    expect(readCachedTranscript(transcriptCacheKey("user-521", {
      projectId: "p1", sessionId: "p1", chatSessionId: "old-chat", workspace: "/workspace/project",
    }))).toMatchObject({ cursor: 100, messages: [{ content: "Authoritative A transcript at 100" }] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
    socket.onMessage({ type: "result", seq: 101, ok: true, output: "Current reply after 100" });
    expect(rt.transcriptCursor).toBe(101);
    expect(rt.messages.value.some((message) => message.content === "Current reply after 100")).toBe(true);
  });

  it("preserves the cached cursor and transcript on a fresh normal resume welcome", async () => {
    const { ctx, ws, rt, socket } = await setup();
    welcome(socket, "old-chat", 50);
    await history(socket, "Cached A transcript", 50);
    const messages = rt.messages.value;
    await ws.connectWs("p1");
    const reconnect = rt.ws as TestSocket;
    expect(reconnect.options.resume).toEqual({ afterSeq: 50, laneGeneration: 1 });
    reconnect.onOpen();
    reconnect.onMessage({
      type: "welcome", chatSessionId: "old-chat", laneGeneration: 1,
      latestSeq: 50, historyMode: "resume", bootstrapHistory: false, inFlight: false,
    });
    await nextTick();
    expect(rt.messages.value).toBe(messages);
    expect(rt.transcriptCursor).toBe(50);
    expect(rt.transcriptReady).toBe(true);
    expect(rt.syncInProgress).toBe(false);
    expect(vi.mocked(ctx.api.get).mock.calls.filter(([path]) => path.startsWith("/api/sync/events"))).toEqual([]);
  });

  it.each([true, false])("discards buffered history/live frames before a same-session snapshot (rejection=%s)", async (rejection) => {
    const { ctx, rt, socket } = await setup();
    welcome(socket, "old-chat", 50);
    await history(socket, "Original A transcript", 50);
    let finish!: (value: unknown) => void;
    vi.mocked(ctx.api.get).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    socket.onMessage({
      type: "welcome", chatSessionId: "old-chat", laneGeneration: 1,
      latestSeq: 80, historyMode: "resume", bootstrapHistory: true, inFlight: false,
    });
    socket.onMessage({ type: "history", afterSeq: 150, items: [{ role: "ai", text: "Buffered stale history", ts: 1 }] });
    socket.onMessage({ type: "result", ok: true, output: "Buffered stale result" });
    socket.onMessage({ type: "delta_snapshot", bootstrap: true, afterSeq: 150, text: "Buffered stale stream" });
    if (rejection) {
      socket.onMessage({ type: "error", code: "session_changed", chat_session_id: "old-chat", message: "Selection changed" });
    }
    welcome(socket, "old-chat", 100);
    await history(socket, "Authoritative A transcript at 100", 100);
    expect(rt.messages.value.map((message) => message.content)).toEqual(["Authoritative A transcript at 100"]);
    expect(rt.transcriptCursor).toBe(100);
    finish({ events: [], latestSeq: 80, truncated: false, hasMore: false, laneGeneration: 1 });
    await nextTick();
    await Promise.resolve();
    expect(rt.messages.value.map((message) => message.content)).toEqual(["Authoritative A transcript at 100"]);
    expect(rt.transcriptCursor).toBe(100);
    expect(rt.needsChatSync).toBe(false);
  });

  it.each(["peer", "source"])("rebinds the outbox on a %s switch and rejects unknown old-session broadcasts", async (origin) => {
    const channels: Array<{ onmessage?: (event: { data: unknown }) => void }> = [];
    vi.stubGlobal("BroadcastChannel", class {
      onmessage?: (event: { data: unknown }) => void;
      constructor() { channels.push(this); }
      postMessage() {}
      close() {}
    });
    const { chat, projects, rt, socket } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    const key = seedInputs(rt, chat);
    const snapshot = JSON.parse(localStorage.getItem(key)!);
    snapshot.queued.push({ clientMessageId: "unknown-old-input", text: "Unknown old input", createdAt: 2 });
    if (origin === "source") await projects.startNewChatSession();
    const selected = origin === "source" ? rt.chatSessionId : "peer-chat";
    welcome(socket, selected);
    await history(socket, "Peer transcript");
    for (const channel of channels) channel.onmessage?.({ data: { key, snapshot } });
    await chat.flushQueuedPrompts(rt);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(socket.promptFrames).not.toHaveBeenCalled();
    const current = {
      key: outboxStorageKey("p1", selected),
      snapshot: { pending: null, sent: [], queued: [{ clientMessageId: "new-peer-input", text: "Current input", createdAt: 3 }], dismissed: [] },
    };
    for (const channel of channels) channel.onmessage?.({ data: current });
    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["new-peer-input"]);
    await chat.flushQueuedPrompts(rt);
    expect(socket.promptFrames).toHaveBeenCalledExactlyOnceWith(expect.anything(), "new-peer-input");
  });

  it.each(["peer", "source"])("fences an old HTTP catch-up while a %s session switch is pending", async (origin) => {
    const { ctx, projects, rt, socket } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    let finish!: (value: unknown) => void;
    vi.mocked(ctx.api.get).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    socket.onMessage({ type: "welcome", chatSessionId: "old-chat", latestSeq: 90, laneGeneration: 1, historyMode: "resume", inFlight: false });
    expect(finish).toBeTypeOf("function");
    if (origin === "source") await projects.startNewChatSession();
    else welcome(socket, "peer-chat");
    finish({ events: [{ seq: 90, type: "result", payload: { type: "result", ok: true, output: "Stale HTTP result" } }], latestSeq: 90, hasMore: false, laneGeneration: 1 });
    await nextTick();
    await Promise.resolve();
    expect(rt.messages.value.some((message) => message.content === "Stale HTTP result")).toBe(false);
    expect(rt.transcriptCursor).toBe(0);
    if (origin === "source") welcome(socket, rt.chatSessionId);
    await history(socket, "New transcript");
    expect(rt.messages.value.map((message) => message.content)).toEqual(["New transcript"]);
    expect(rt.transcriptCursor).toBe(2);
  });

  it("starts a new chat in band without PATCH and keeps new input behind its welcome", async () => {
    const { projects, chat, rt, socket, patch } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    seedInputs(rt, chat);
    await projects.startNewChatSession();
    const selected = rt.chatSessionId;
    expect(socket.switchChatSession).toHaveBeenCalledExactlyOnceWith(selected);
    expect(socket.close).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(rt.pendingAckClientMessageId).toBeNull();
    rt.queuedPrompts.value = [{ id: "new", clientMessageId: "new-input", text: "New prompt", images: [], createdAt: 2 }];
    socket.onMessage({ type: "result", ok: false, output: "Old turn aborted" });
    await chat.flushQueuedPrompts(rt);
    expect(socket.promptFrames).not.toHaveBeenCalled();
    welcome(socket, selected);
    expect(rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId)).toEqual(["new-input"]);
    socket.onMessage({ type: "prompt_reconcile_result", identities: [{ clientMessageId: "new-input", disposition: "unseen" }] });
    await history(socket, "Review-only history");
    expect(socket.promptFrames).toHaveBeenCalledTimes(1);
    expect(socket.promptFrames.mock.calls[0]?.[1]).toBe("new-input");
  });

  it.each(["disconnected", "failed-send", "lost-welcome"])("preserves %s new-chat intent across canonical reconnect bootstrap", async (failure) => {
    const { projects, ctx, ws, rt, socket, patch } = await setup();
    welcome(socket, "old-chat");
    await history(socket, "Old transcript");
    if (failure === "disconnected") rt.connected.value = false;
    if (failure === "failed-send") socket.switchChatSession.mockReturnValue(false);
    await projects.startNewChatSession();
    const selected = rt.chatSessionId;
    if (failure === "lost-welcome") await ws.connectWs("p1");
    const reconnect = rt.ws as TestSocket;
    expect(reconnect).not.toBe(socket);
    reconnect.onOpen();
    welcome(reconnect, "canonical-before-switch");
    expect(reconnect.switchChatSession).toHaveBeenCalledExactlyOnceWith(selected);
    await history(reconnect, "Wrong session history");
    expect(rt.messages.value.some((message) => message.content === "Wrong session history")).toBe(false);
    expect(ctx.getRuntime("p1").chatSessionId).toBe(selected);
    welcome(reconnect, selected);
    await history(reconnect, "Selected history");
    expect(rt.messages.value.map((message) => message.content)).toEqual(["Selected history"]);
    expect(rt.syncInProgress).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    welcome(reconnect, "later-peer-selection");
    expect(rt.chatSessionId).toBe("later-peer-selection");
    expect(reconnect.switchChatSession).toHaveBeenCalledTimes(1);
  });
});
