import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getAgentFeatureFlags } from "../../src/agents/config.js";

describe("agents/config", () => {
  it("returns codexEnabled as true", () => {
    const flags = getAgentFeatureFlags();
    assert.equal(flags.codexEnabled, true);
  });
});
