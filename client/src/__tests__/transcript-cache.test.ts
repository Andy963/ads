import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { createProjectRuntime } from "../app/projectRuntime";
import { createTranscriptCache, readCachedTranscript, transcriptCacheKey, TRANSCRIPT_OWNER_KEY } from "../app/transcriptCache";

const scope = { projectId: "p-1", sessionId: "s-1", chatSessionId: "main", workspace: "/tmp/project" };
const message = { id: "answer-1", role: "assistant" as const, kind: "text" as const, content: "Cached answer" };
const caches: ReturnType<typeof createTranscriptCache>[] = [];

function createCache(owner = "user-1") {
  const cache = createTranscriptCache();
  caches.push(cache);
  cache.setOwner(owner);
  return cache;
}

function seed() {
  const cache = createCache();
  const rt = createProjectRuntime({ maxLiveActivitySteps: 5 });
  cache.attach(rt, scope);
  rt.laneGeneration = 2;
  rt.transcriptCursor = 15;
  rt.transcriptReady = true;
  rt.messages.value = [message];
  return { cache, rt, key: transcriptCacheKey("user-1", scope) };
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => {
  for (const cache of caches.splice(0)) cache.dispose();
  vi.useRealTimers();
  localStorage.clear();
});

describe("atomic transcript cache", () => {
  it("hydrates the transcript, cursor, generation and viewport synchronously", () => {
    const { cache, rt } = seed();
    rt.transcriptViewport.value = { following: false, firstLoadedId: message.id, anchorId: message.id, anchorOffset: -12, scrollTop: 200 };
    cache.flush();
    const restored = createProjectRuntime({ maxLiveActivitySteps: 5 });
    createCache().attach(restored, scope);
    expect(restored.messages.value).toEqual([message]);
    expect(restored.transcriptCursor).toBe(15);
    expect(restored.laneGeneration).toBe(2);
    expect(restored.transcriptReady).toBe(true);
    expect(restored.transcriptViewport.value).toEqual(rt.transcriptViewport.value);
  });

  it.each([
    { streaming: "true" }, { transient: [] }, { ts: -1 }, { commandsTotal: "many" },
    { execution: [] }, { execution: { model: {} } }, { kind: "thought" },
    { patch: { files: [], diff: "", truncated: "yes" } },
  ])("rejects corrupt optional message fields %o", (fields) => {
    const { cache, key } = seed();
    cache.flush();
    const stored = JSON.parse(localStorage.getItem(key)!);
    Object.assign(stored.messages[0], fields);
    localStorage.setItem(key, JSON.stringify(stored));
    expect(readCachedTranscript(key)).toBeNull();
  });

  it("coalesces writes and saves the committed content and cursor in one record", async () => {
    const { rt, key } = seed();
    const write = vi.spyOn(Storage.prototype, "setItem");
    await nextTick();
    rt.messages.value = [message, { ...message, id: "answer-2", content: "New answer" }];
    rt.transcriptCursor = 17;
    rt.transcriptCache!.schedule();
    await nextTick();
    expect(localStorage.getItem(key)).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(write.mock.calls.filter(([writtenKey]) => writtenKey === key)).toHaveLength(1);
    expect(readCachedTranscript(key)).toMatchObject({ cursor: 17, messages: rt.messages.value, complete: true });
  });

  it.each([
    { projectId: "p-2" }, { sessionId: "s-2" }, { chatSessionId: "advisor" }, { workspace: "/tmp/other" },
  ])("isolates cached data by %o", (changed) => {
    const { cache } = seed();
    cache.flush();
    const other = createProjectRuntime({ maxLiveActivitySteps: 5 });
    cache.attach(other, { ...scope, ...changed });
    expect(other.messages.value).toEqual([]);
    expect(other.transcriptReady).toBe(false);
  });

  it("clears the previous owner's records and fences pending writes on account change", async () => {
    const { cache, rt, key } = seed();
    cache.flush();
    rt.messages.value = [{ ...message, content: "Pending write" }];
    await nextTick();
    cache.setOwner("user-2");
    await vi.runAllTimersAsync();
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT_OWNER_KEY)).toBe("user-2");
    const other = createProjectRuntime({ maxLiveActivitySteps: 5 });
    cache.attach(other, scope);
    expect(other.messages.value).toEqual([]);
  });

  it("retains review-only messages on a new session without transferring the old cursor", () => {
    const { cache, rt, key } = seed();
    rt.transcriptViewport.value = { following: false, firstLoadedId: message.id, anchorId: message.id, anchorOffset: 0, scrollTop: 240 };
    cache.attach(rt, { ...scope, chatSessionId: "new-session" });
    expect(rt.messages.value).toEqual([message]);
    expect(rt.transcriptViewport.value).toBeNull();
    expect(rt.transcriptCursor).toBe(0);
    expect(rt.transcriptReady).toBe(false);
    expect(readCachedTranscript(key)).toMatchObject({ messages: [message], cursor: 15 });
  });

  it("detaches removed runtimes so later flushes cannot recreate their cache", async () => {
    const { cache, rt, key } = seed();
    cache.flush();
    cache.detach(rt);
    rt.messages.value = [{ ...message, content: "Late callback" }];
    await nextTick();
    cache.flush();
    await vi.runAllTimersAsync();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("keeps partial text readable but never fast-resumes an incomplete cold baseline", () => {
    const { cache, rt } = seed();
    rt.messages.value = [{ ...message, streaming: true }];
    rt.busy.value = true;
    cache.flush();
    const restored = createProjectRuntime({ maxLiveActivitySteps: 5 });
    createCache().attach(restored, scope);
    expect(restored.messages.value[0]?.content).toBe(message.content);
    expect(restored.messages.value[0]?.streaming).toBe(false);
    expect(restored.transcriptCursor).toBe(0);
    expect(restored.transcriptReady).toBe(false);
  });

  it("invalidates a pending snapshot before resetting a lane", async () => {
    const { cache, rt, key } = seed();
    cache.flush();
    await nextTick();
    rt.transcriptCache!.invalidate();
    rt.messages.value = [];
    await nextTick();
    await vi.runAllTimersAsync();
    expect(readCachedTranscript(key)).toMatchObject({ cursor: 0, complete: false, messages: [] });
  });

  it.each(["{", "null", '{"version":99}', '{"version":1,"messages":[null]}'])("ignores corrupt or unsupported records: %s", (raw) => {
    const key = transcriptCacheKey("user-1", scope);
    localStorage.setItem(key, raw);
    const rt = createProjectRuntime({ maxLiveActivitySteps: 5 });
    createCache().attach(rt, scope);
    expect(rt.messages.value).toEqual([]);
    expect(rt.transcriptReady).toBe(false);
  });

  it("ignores malformed nested message data instead of crashing the renderer", () => {
    const { cache, key } = seed();
    cache.flush();
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.messages[0].patch = { files: [null], diff: "" };
    localStorage.setItem(key, JSON.stringify(stored));
    expect(readCachedTranscript(key)).toBeNull();
  });

  it("keeps the last valid record rather than persisting an oversized tail", () => {
    const { cache, rt, key } = seed();
    cache.flush();
    rt.messages.value = [{ ...message, content: "x".repeat(1_000_001) }];
    rt.transcriptCursor = 99;
    cache.flush();
    expect(readCachedTranscript(key)).toMatchObject({ cursor: 15, messages: [message] });
  });

  it("tolerates unavailable storage and quota errors without touching unrelated data", () => {
    const { cache, key } = seed();
    localStorage.setItem("ads.outbox.s-1.main", "keep");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    expect(() => cache.flush()).not.toThrow();
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("ads.outbox.s-1.main")).toBe("keep");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    expect(() => createCache()).not.toThrow();
    expect(readCachedTranscript(key)).toBeNull();
  });
});
