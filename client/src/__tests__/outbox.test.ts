import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createOutboxStore,
  isEmptyOutboxSnapshot,
  legacyPendingPromptStorageKey,
  outboxStorageKey,
  type OutboxSnapshot,
} from "../app/outbox";

const KEY = outboxStorageKey("session-a", "main");

function prompt(clientMessageId: string, text: string) {
  return { clientMessageId, text, createdAt: 1_000 };
}

describe("outbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("survives a reload: the queue is read back from localStorage, not sessionStorage", () => {
    const store = createOutboxStore();
    store.write(KEY, { pending: prompt("m-1", "sent"), queued: [prompt("m-2", "waiting")] });

    // A fresh store stands in for a reloaded tab.
    const reloaded = createOutboxStore().read(KEY);
    expect(reloaded.pending?.clientMessageId).toBe("m-1");
    expect(reloaded.queued.map((entry) => entry.text)).toEqual(["waiting"]);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("removes the storage entry once the outbox drains", () => {
    const store = createOutboxStore();
    store.write(KEY, { pending: prompt("m-1", "sent"), queued: [] });
    expect(localStorage.getItem(KEY)).not.toBeNull();

    store.write(KEY, { pending: null, queued: [] });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(isEmptyOutboxSnapshot(store.read(KEY))).toBe(true);
  });

  it("notifies subscribers when another tab changes the same lane", async () => {
    const writer = createOutboxStore();
    const reader = createOutboxStore();
    const seen: Array<{ key: string; snapshot: OutboxSnapshot }> = [];
    reader.subscribe((key, snapshot) => seen.push({ key, snapshot }));

    writer.write(KEY, { pending: null, queued: [prompt("m-9", "from the other tab")] });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.key).toBe(KEY);
    expect(seen[0]?.snapshot.queued.map((entry) => entry.text)).toEqual(["from the other tab"]);

    writer.close();
    reader.close();
  });

  it("drops malformed and duplicate entries instead of replaying them", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        pending: { text: "no client message id" },
        queued: [prompt("m-1", "first"), prompt("m-1", "duplicate"), null, "nonsense"],
      }),
    );

    const snapshot = createOutboxStore().read(KEY);
    expect(snapshot.pending).toBeNull();
    expect(snapshot.queued.map((entry) => entry.text)).toEqual(["first"]);
  });

  it("adopts a pending prompt written by the previous sessionStorage layout", () => {
    const legacyKey = legacyPendingPromptStorageKey("session-a", "main");
    sessionStorage.setItem(legacyKey, JSON.stringify(prompt("m-legacy", "written before the upgrade")));

    const store = createOutboxStore();
    store.migrateLegacyPending({ key: KEY, legacyKey });

    expect(store.read(KEY).pending?.text).toBe("written before the upgrade");
    // Consumed, so a later migration cannot resurrect it.
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it("keeps a newer pending prompt when a legacy entry is still around", () => {
    const legacyKey = legacyPendingPromptStorageKey("session-a", "main");
    sessionStorage.setItem(legacyKey, JSON.stringify(prompt("m-legacy", "stale")));
    const store = createOutboxStore();
    store.write(KEY, { pending: prompt("m-current", "current"), queued: [] });

    store.migrateLegacyPending({ key: KEY, legacyKey });

    expect(store.read(KEY).pending?.clientMessageId).toBe("m-current");
  });

  it("keeps working when storage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const store = createOutboxStore();

    expect(() => store.write(KEY, { pending: prompt("m-1", "x"), queued: [] })).not.toThrow();
    setItem.mockRestore();
    expect(isEmptyOutboxSnapshot(store.read(KEY))).toBe(true);
  });
});
