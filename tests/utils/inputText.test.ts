import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractTextFromInput } from "../../server/utils/inputText.js";
import type { Input } from "../../server/agents/protocol/types.js";

describe("extractTextFromInput", () => {
  it("returns string input unchanged when trim is false", () => {
    assert.equal(extractTextFromInput(" hi  \n"), " hi  \n");
  });

  it("trims string input when trim is true", () => {
    assert.equal(extractTextFromInput(" hi  \n", { trim: true }), "hi");
  });

  it("joins text parts with newline and ignores local_image by default", () => {
    const input: Input = [
      { type: "text", text: "hello" },
      { type: "local_image", path: "/tmp/a.png" },
      { type: "text", text: "world" },
    ];
    assert.equal(extractTextFromInput(input), "hello\nworld");
  });

  it("preserves trailing whitespace/newlines when trim is false", () => {
    const input: Input = [
      { type: "text", text: "hello\n" },
      { type: "local_image", path: "/tmp/a.png" },
      { type: "text", text: "world\n\n" },
    ];
    assert.equal(extractTextFromInput(input), "hello\n\nworld\n\n");
  });

  it("trims the final output when trim is true", () => {
    const input: Input = [
      { type: "text", text: "hello\n" },
      { type: "local_image", path: "/tmp/a.png" },
      { type: "text", text: "world\n\n" },
    ];
    assert.equal(extractTextFromInput(input, { trim: true }), "hello\n\nworld");
  });

  it("returns empty string for image-only inputs", () => {
    const input: Input = [{ type: "local_image", path: "/tmp/a.png" }];
    assert.equal(extractTextFromInput(input), "");
    assert.equal(extractTextFromInput(input, { trim: true }), "");
  });
});

