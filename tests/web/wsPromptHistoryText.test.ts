import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPromptHistoryText } from "../../server/web/server/ws/promptHistory.js";

const sanitizeInput = (payload: unknown): string | null => {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
    const command = (payload as Record<string, unknown>).command;
    return typeof command === "string" ? command : null;
  }
  return null;
};

describe("web/server/ws/promptHistory", () => {
  it("stores plain string prompts", () => {
    const res = buildPromptHistoryText("hello", sanitizeInput);
    assert.equal(res.ok, true);
    assert.equal(res.text, "hello");
  });

  it("appends Images: N when prompt includes images but no attachment references", () => {
    const res = buildPromptHistoryText({ text: "hello", images: [{ data: "x" }, { data: "y" }] }, sanitizeInput);
    assert.equal(res.ok, true);
    assert.equal(res.text, "hello\nImages: 2");
  });

  it("omits Images: N when prompt text already references /api/attachments/", () => {
    const text = "hello\n\n![attachment 1](/api/attachments/att-1/raw)";
    const res = buildPromptHistoryText({ text, images: [{ data: "x" }] }, sanitizeInput);
    assert.equal(res.ok, true);
    assert.equal(res.text, text);
  });

  it("stores image-only prompts as Images: N", () => {
    const res = buildPromptHistoryText({ text: "", images: [{ data: "x" }] }, sanitizeInput);
    assert.equal(res.ok, true);
    assert.equal(res.text, "Images: 1");
  });
});

