import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkText } from "../../src/vectorSearch/chunking.js";

describe("vectorSearch/chunking", () => {
  it("splits text into chunks with max char bound", () => {
    const text = Array.from({ length: 50 }).map((_, i) => `Para ${i}\n${"x".repeat(120)}`).join("\n\n");
    const chunks = chunkText(text, { maxChars: 400, overlapChars: 50 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 400);
      assert.ok(chunk.text.trim().length > 0);
    }
  });

  it("returns empty for blank input", () => {
    assert.deepEqual(chunkText("   \n\n", { maxChars: 100, overlapChars: 10 }), []);
  });
});

