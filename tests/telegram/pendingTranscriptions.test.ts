import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PendingTranscriptionStore } from "../../server/telegram/utils/pendingTranscriptions.js";

describe("telegram/pendingTranscriptions", () => {
  it("consumes pending transcription exactly once", () => {
    const store = new PendingTranscriptionStore({ ttlMs: 5_000 });
    store.add({ chatId: 1, previewMessageId: 10, text: "hello", nowMs: 1000 });

    assert.deepEqual(store.consume({ chatId: 1, previewMessageId: 10, nowMs: 2000 }), { status: "ok", text: "hello" });
    assert.deepEqual(store.consume({ chatId: 1, previewMessageId: 10, nowMs: 2001 }), { status: "already_submitted" });
    assert.deepEqual(store.discard({ chatId: 1, previewMessageId: 10, nowMs: 2002 }), { status: "already_submitted" });
  });

  it("discards pending transcription and blocks submit", () => {
    const store = new PendingTranscriptionStore({ ttlMs: 5_000 });
    store.add({ chatId: 1, previewMessageId: 11, text: "hello", nowMs: 1000 });

    assert.deepEqual(store.discard({ chatId: 1, previewMessageId: 11, nowMs: 1500 }), { status: "ok" });
    assert.deepEqual(store.consume({ chatId: 1, previewMessageId: 11, nowMs: 1501 }), { status: "already_discarded" });
    assert.deepEqual(store.discard({ chatId: 1, previewMessageId: 11, nowMs: 1502 }), { status: "already_discarded" });
  });

  it("expires pending transcription after ttl", () => {
    const store = new PendingTranscriptionStore({ ttlMs: 5_000 });
    store.add({ chatId: 2, previewMessageId: 20, text: "hello", nowMs: 1000 });

    assert.equal(store.get({ chatId: 2, previewMessageId: 20, nowMs: 5999 })?.text, "hello");
    assert.equal(store.get({ chatId: 2, previewMessageId: 20, nowMs: 6000 }), null);
    assert.deepEqual(store.consume({ chatId: 2, previewMessageId: 20, nowMs: 6001 }), { status: "missing" });
  });
});

