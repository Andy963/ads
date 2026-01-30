import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { parsePositiveInt, resolveDefaultMaxToolRounds } from "../../src/agents/hub/toolLoop.js";

describe("agents/hub/toolLoop", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.ADS_AGENT_MAX_TOOL_ROUNDS = process.env.ADS_AGENT_MAX_TOOL_ROUNDS;
    originalEnv.AGENT_MAX_TOOL_ROUNDS = process.env.AGENT_MAX_TOOL_ROUNDS;
  });

  afterEach(() => {
    if (originalEnv.ADS_AGENT_MAX_TOOL_ROUNDS === undefined) delete process.env.ADS_AGENT_MAX_TOOL_ROUNDS;
    else process.env.ADS_AGENT_MAX_TOOL_ROUNDS = originalEnv.ADS_AGENT_MAX_TOOL_ROUNDS;
    if (originalEnv.AGENT_MAX_TOOL_ROUNDS === undefined) delete process.env.AGENT_MAX_TOOL_ROUNDS;
    else process.env.AGENT_MAX_TOOL_ROUNDS = originalEnv.AGENT_MAX_TOOL_ROUNDS;
  });

  it("parsePositiveInt falls back for invalid values", () => {
    assert.equal(parsePositiveInt(undefined, 3), 3);
    assert.equal(parsePositiveInt("", 3), 3);
    assert.equal(parsePositiveInt("0", 3), 3);
    assert.equal(parsePositiveInt("-1", 3), 3);
    assert.equal(parsePositiveInt("nope", 3), 3);
  });

  it("parsePositiveInt parses positive ints", () => {
    assert.equal(parsePositiveInt("1", 3), 1);
    assert.equal(parsePositiveInt(" 4 ", 3), 4);
  });

  it("resolveDefaultMaxToolRounds defaults to unlimited (0)", () => {
    delete process.env.ADS_AGENT_MAX_TOOL_ROUNDS;
    delete process.env.AGENT_MAX_TOOL_ROUNDS;
    assert.equal(resolveDefaultMaxToolRounds(), 0);
  });

  it("resolveDefaultMaxToolRounds reads ADS env first", () => {
    process.env.AGENT_MAX_TOOL_ROUNDS = "2";
    process.env.ADS_AGENT_MAX_TOOL_ROUNDS = "5";
    assert.equal(resolveDefaultMaxToolRounds(), 5);
  });

  it("resolveDefaultMaxToolRounds supports off aliases", () => {
    process.env.ADS_AGENT_MAX_TOOL_ROUNDS = "off";
    assert.equal(resolveDefaultMaxToolRounds(), 0);
  });

  it("resolveDefaultMaxToolRounds ignores invalid values", () => {
    process.env.ADS_AGENT_MAX_TOOL_ROUNDS = "wat";
    assert.equal(resolveDefaultMaxToolRounds(), 0);
  });
});

