import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderTelegramOutbound } from "../../src/telegram/adapters/codex/renderOutbound.js";

describe("telegram outbound renderer", () => {
  it("renders text as MarkdownV2", () => {
    const out = renderTelegramOutbound("hello_world");
    assert.equal(out.parseMode, "MarkdownV2");
    assert.notEqual(out.text, "hello_world");
    assert.equal(out.plainTextFallback, "hello_world");
  });

  it("always uses MarkdownV2 even for long text", () => {
    const raw = "prefix <tag>\n\n**bold**\n\n```code```";
    const out = renderTelegramOutbound(raw);
    assert.equal(out.parseMode, "MarkdownV2");
    assert.equal(out.plainTextFallback, raw);
  });

  it("returns empty string for empty input", () => {
    const out = renderTelegramOutbound("");
    assert.equal(out.parseMode, "MarkdownV2");
    assert.equal(out.text, "");
    assert.equal(out.plainTextFallback, "");
  });
});
