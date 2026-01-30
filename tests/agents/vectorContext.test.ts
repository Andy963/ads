import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractVectorQuery, formatVectorAutoContextSummary, injectVectorContext } from "../../src/agents/hub/vectorContext.js";

describe("agents/hub/vectorContext", () => {
  it("extracts vector query from a marker section", () => {
    const query = extractVectorQuery(["header", "", "用户输入:", "hello world"].join("\n"));
    assert.equal(query, "hello world");
  });

  it("falls back to full text when marker missing", () => {
    const query = extractVectorQuery("  hello  ");
    assert.equal(query, "hello");
  });

  it("injects vector context before marker when present", () => {
    const injected = injectVectorContext("prefix\n用户输入:\nabc", "CTX").toString();
    assert.ok(injected.includes("CTX"));
    const ctxPos = injected.indexOf("CTX");
    const markerPos = injected.indexOf("用户输入:");
    assert.ok(ctxPos >= 0 && markerPos >= 0 && ctxPos < markerPos, "context should appear before marker");
  });

  it("injects vector context as a leading text part for array inputs", () => {
    const out = injectVectorContext([{ type: "text", text: "hello" }], "CTX");
    assert.ok(Array.isArray(out));
    const first = out[0] as { type?: string; text?: string };
    assert.equal(first.type, "text");
    assert.equal(first.text, "CTX");
  });

  it("formats vector auto context report summary", () => {
    const summary = formatVectorAutoContextSummary({
      ok: true,
      injected: true,
      cacheHit: true,
      elapsedMs: 12.5,
      injectedChars: 300,
      hits: 5,
      filtered: 2,
      retryCount: 0,
      httpStatus: 200,
      code: "ok",
      providerCode: "test",
      message: "done",
      queryHash: "abc123",
    });
    assert.ok(summary.includes("VectorSearch(auto)"));
    assert.ok(summary.includes("qhash=abc123"));
  });
});

