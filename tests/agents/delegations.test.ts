import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractDelegationDirectives, looksLikeSupervisorVerdict, stripDelegationBlocks } from "../../src/agents/hub/delegations.js";

describe("agents/hub/delegations", () => {
  it("extracts delegation directives and normalizes agent id", () => {
    const text = ["hello", "<<<agent.CoDeX", "do work", ">>>", "<<<agent.gemini", "do more", ">>>"].join("\n");
    const directives = extractDelegationDirectives(text);
    assert.equal(directives.length, 2);
    assert.equal(directives[0]?.agentId, "codex");
    assert.equal(directives[0]?.prompt, "do work");
    assert.equal(directives[1]?.agentId, "gemini");
  });

  it("supports excluding an agent id", () => {
    const text = ["<<<agent.codex", "do work", ">>>", "<<<agent.gemini", "do more", ">>>"].join("\n");
    const directives = extractDelegationDirectives(text, "codex");
    assert.equal(directives.length, 1);
    assert.equal(directives[0]?.agentId, "gemini");
  });

  it("strips delegation blocks and collapses excessive blank lines", () => {
    const text = ["a", "", "<<<agent.codex", "x", ">>>", "", "", "b"].join("\n");
    const stripped = stripDelegationBlocks(text);
    assert.equal(stripped, "a\n\nb");
  });

  it("detects a supervisor verdict JSON", () => {
    const verdict = [
      "```json",
      JSON.stringify({ verdicts: [{ taskId: "t1", accept: true, note: "ok" }] }, null, 2),
      "```",
    ].join("\n");
    assert.equal(looksLikeSupervisorVerdict(verdict), true);
  });
});

