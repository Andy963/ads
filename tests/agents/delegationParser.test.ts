import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractDelegationDirectivesWithRanges } from "../../server/agents/delegationParser.js";

describe("agents/delegationParser", () => {
  it("requires directive start at beginning of line", () => {
    const text = ["hello <<<agent.codex", "do work", ">>>"].join("\n");
    const directives = extractDelegationDirectivesWithRanges(text);
    assert.equal(directives.length, 0);
  });

  it("does not treat embedded >>> as terminator unless on its own line", () => {
    const text = ["<<<agent.codex", "keep >>> inside", ">>>"].join("\n");
    const directives = extractDelegationDirectivesWithRanges(text);
    assert.equal(directives.length, 1);
    assert.equal(directives[0]?.agentId, "codex");
    assert.equal(directives[0]?.prompt, "keep >>> inside");
  });

  it("parses multiple identical blocks with distinct ranges", () => {
    const text = ["<<<agent.codex", "x", ">>>", "mid", "<<<agent.codex", "x", ">>>"].join("\n");
    const directives = extractDelegationDirectivesWithRanges(text);
    assert.equal(directives.length, 2);
    assert.ok((directives[0]?.start ?? 0) < (directives[1]?.start ?? 0));
    assert.ok((directives[0]?.end ?? 0) < (directives[1]?.end ?? 0));
  });

  it("ignores unterminated blocks", () => {
    const text = ["<<<agent.codex", "x"].join("\n");
    const directives = extractDelegationDirectivesWithRanges(text);
    assert.equal(directives.length, 0);
  });
});

