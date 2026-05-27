import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { estimateMessagesTokens, estimateTokens } from "../../server/context/tokenEstimator.js";

describe("context/tokenEstimator", () => {
  it("estimates roughly one token per four chars", () => {
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(estimateMessagesTokens([{ role: "user", content: "12345678" }]), 6);
  });
});
