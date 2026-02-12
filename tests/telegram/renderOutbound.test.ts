import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderTelegramOutbound } from "../../src/telegram/adapters/codex/renderOutbound.js";

describe("telegram outbound renderer", () => {
  it("renders short text as MarkdownV2", () => {
    const out = renderTelegramOutbound("hello_world", { collapseMinChars: 1000 });
    assert.equal(out.parseMode, "MarkdownV2");
    assert.notEqual(out.text, "hello_world");
    assert.equal(out.plainTextFallback, "hello_world");
  });

  it("renders long text as HTML expandable blockquote", () => {
    const raw = "prefix <tag>\n\n**bold**\n\n```code```";
    const out = renderTelegramOutbound(raw, { collapseMinChars: 1 });
    assert.equal(out.parseMode, "HTML");
    assert.ok(out.text.includes("<blockquote expandable>"));
    assert.ok(out.text.includes("&lt;tag&gt;"));
    assert.ok(out.text.includes("<b>bold</b>"));
    assert.ok(out.text.includes("<pre>code</pre>"));
  });
});

