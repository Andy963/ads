import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../src/agents/cli/stripAnsi.js";

describe("stripAnsi", () => {
  it("removes CSI sequences", () => {
    assert.equal(stripAnsi("\u001b[32mhello\u001b[0m"), "hello");
  });

  it("removes simple escape sequences", () => {
    assert.equal(stripAnsi("\u001bAhello\u001bB"), "hello");
  });

  it("keeps plain text untouched", () => {
    assert.equal(stripAnsi("no ansi here"), "no ansi here");
  });
});

