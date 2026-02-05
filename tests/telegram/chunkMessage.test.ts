import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkMessage } from "../../src/telegram/adapters/codex/chunkMessage.js";

describe("telegram/adapters/codex/chunkMessage", () => {
  it("returns a single chunk when under limit", () => {
    const chunks = chunkMessage("hello", 10);
    assert.deepEqual(chunks, ["hello"]);
  });

  it("keeps code fences balanced across chunks", () => {
    const bodyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = ["```ts", ...bodyLines, "```", "tail"].join("\n");

    const maxLen = 60;
    const chunks = chunkMessage(text, maxLen);
    assert.ok(chunks.length > 1, "should split into multiple chunks");

    assert.ok(chunks[0]?.startsWith("```ts\n"), "first chunk should keep original fence language");
    assert.ok(chunks[1]?.startsWith("```ts\n"), "continuation chunks should reopen with the same fence language");

    for (const chunk of chunks) {
      assert.ok(chunk.length <= maxLen, `chunk should not exceed maxLen, got ${chunk.length}`);
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      assert.equal(fenceCount % 2, 0, `chunk must have balanced fences, got ${fenceCount}`);
    }

    assert.ok(chunks.at(-1)?.includes("tail"), "last chunk should include tail");
  });
});
