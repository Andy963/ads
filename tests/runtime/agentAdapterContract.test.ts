import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { AgentAdapter } from "../../server/agents/types.js";
import { isNativeExecutionId } from "../../server/runtime/sessionIdentity.js";

function assertSharedAgentAdapterContract(adapter: AgentAdapter): void {
  assert.equal(adapter.id, "codex");
  assert.equal(adapter.status().ready, true);
  assert.equal(typeof adapter.send, "function");
  assert.equal(typeof adapter.onEvent, "function");
  assert.equal(typeof adapter.reset, "function");
  assert.deepEqual(
    adapter.metadata.capabilities.filter((capability) => ["text", "files", "commands"].includes(capability)),
    ["text", "files", "commands"],
  );

  let eventCount = 0;
  const unsubscribe = adapter.onEvent(() => {
    eventCount += 1;
  });
  unsubscribe();
  assert.equal(eventCount, 0);

  adapter.setModel?.("contract-model");
  adapter.setModelReasoningEffort?.("medium");
  adapter.reset();
}

describe("shared AgentAdapter contract", () => {
  it("exposes the same lifecycle surface for Codex and Native adapters", () => {
    const codex = new CodexAppServerAdapter({ projectId: "contract-codex" });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-adapter-contract-"));
    try {
      const native = new NativeAgentAdapter({
        credentialOwner: "contract-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "contract-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
          }),
        },
      });

      assertSharedAgentAdapterContract(codex);
      assertSharedAgentAdapterContract(native);
      assert.equal(codex.getThreadId(), null);
      assert.equal(isNativeExecutionId(native.getThreadId()), true);
      assert.notEqual(codex.getThreadId(), native.getThreadId());
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
