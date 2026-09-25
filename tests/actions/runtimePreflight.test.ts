import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS_REQUIRED_CAPABILITIES,
  checkActionsRuntimePreflight,
} from "../../server/actions/runtimePreflight.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";

describe("Actions runtime preflight", () => {
  it("accepts both mutually exclusive runtime backends", () => {
    for (const backend of ["codex-app-server", "native"] as const) {
      const result = checkActionsRuntimePreflight({
        backend,
        capabilities: ACTIONS_REQUIRED_CAPABILITIES,
        requireDurableState: true,
      });

      assert.equal(result.ok, true, `${backend} should satisfy Actions requirements`);
      assert.equal(result.backend, backend);
      assert.deepEqual(result.missingCapabilities, []);
      assert.deepEqual(result.unsupportedRuntimeCapabilities, []);
    }
  });

  it("fails deterministically when a required capability is unavailable", () => {
    const result = checkActionsRuntimePreflight({
      backend: "native",
      capabilities: ["text", "files"],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingCapabilities, ["commands"]);
    assert.match(result.reason ?? "", /missing capabilities: commands/);
  });

  it("fails when a runtime cannot provide a required lifecycle capability", () => {
    const result = checkActionsRuntimePreflight({
      backend: "native",
      capabilities: ACTIONS_REQUIRED_CAPABILITIES,
      runtimeCapabilities: { "provider-thread-resume": "unsupported" },
      requireProviderResume: true,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.unsupportedRuntimeCapabilities, ["provider-thread-resume"]);
    assert.match(result.reason ?? "", /unsupported runtime capabilities/);
  });

  it("derives Native Actions capabilities from the resolved provider", () => {
    const adapter = new NativeAgentAdapter({
      credentialOwner: "preflight-owner",
      workspaceRoot: "/tmp/ads-preflight-workspace",
      modelResolver: {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-key",
          provider: "test",
          capabilities: { toolCalls: "unsupported", imageInput: "supported" },
        }),
      },
    });

    assert.deepEqual(adapter.getCapabilities(), ["text", "images"]);
    const result = checkActionsRuntimePreflight({
      backend: "native",
      capabilities: adapter.getCapabilities(),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingCapabilities, ["files", "commands"]);
  });
});
