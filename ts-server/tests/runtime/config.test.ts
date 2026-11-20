import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_RUNTIME, resolveAgentRuntime } from "../../server/runtime/config.js";

describe("agent runtime resolution", () => {
  it("defaults to the native runtime when ADS_AGENT_RUNTIME is unset or blank", () => {
    assert.equal(DEFAULT_AGENT_RUNTIME, "native");
    assert.equal(resolveAgentRuntime({}), "native");
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "   " }), "native");
  });

  it("accepts the native runtime aliases", () => {
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "native" }), "native");
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "in-process" }), "native");
  });

  it("selects the Codex app-server runtime only when explicitly requested", () => {
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "codex-app-server" }), "codex-app-server");
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "codex" }), "codex-app-server");
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "cli" }), "codex-app-server");
  });

  it("does not fall back to native full-access execution for an unknown value", () => {
    assert.equal(resolveAgentRuntime({ ADS_AGENT_RUNTIME: "nativ" }), "codex-app-server");
  });
});
