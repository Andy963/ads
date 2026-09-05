import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeTelegramMarkdownV2 } from "../src/utils/markdown.js";
import { chunkMessage } from "../src/utils/chunkMessage.js";

describe("connector markdown and chunking", () => {
  it("escapes text while preserving code blocks", () => {
    const input = "Some text with _underscores_ and `inline` code\n```typescript\nconst x = 1;\n```";
    const escaped = escapeTelegramMarkdownV2(input);
    assert.ok(escaped.includes("```typescript"));
  });

  it("chunks messages exceeding length limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${'x'.repeat(100)}`);
    const longText = lines.join("\n");
    const chunks = chunkMessage(longText, 1500);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.length <= 1500));
  });
});
