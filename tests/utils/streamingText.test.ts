import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeStreamingText } from "../../server/utils/streamingText.js";

describe("utils/streamingText.mergeStreamingText", () => {
  it("treats next as cumulative when next starts with prev", () => {
    const first = mergeStreamingText("", "hello");
    assert.equal(first.delta, "hello");
    assert.equal(first.full, "hello");

    const second = mergeStreamingText(first.full, "hello world");
    assert.equal(second.delta, " world");
    assert.equal(second.full, "hello world");
  });

  it("treats next as incremental when it does not start with prev", () => {
    const first = mergeStreamingText("", "he");
    assert.equal(first.delta, "he");
    assert.equal(first.full, "he");

    const second = mergeStreamingText(first.full, "llo");
    assert.equal(second.delta, "llo");
    assert.equal(second.full, "hello");
  });

  it("dedupes overlap between prev suffix and next prefix", () => {
    const merged = mergeStreamingText("hello", "lo world");
    assert.equal(merged.delta, " world");
    assert.equal(merged.full, "hello world");
  });

  it("ignores truncated cumulative payloads that are prefixes of prev", () => {
    const merged = mergeStreamingText("hello world", "hello");
    assert.equal(merged.delta, "");
    assert.equal(merged.full, "hello world");
  });
});

