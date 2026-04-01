import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleSetAgentCommand } from "../../server/web/server/ws/commandAgentSwitch.js";

describe("web/ws/commandAgentSwitch", () => {
  it("rejects payloads without agentId", () => {
    const sent: unknown[] = [];
    const originalOrchestrator = { id: "original" } as any;

    const orchestrator = handleSetAgentCommand({
      payload: {},
      userId: 7,
      currentCwd: "/tmp/project",
      orchestrator: originalOrchestrator,
      sessionManager: {} as any,
      agentAvailability: {} as any,
      sendToClient: (payload) => sent.push(payload),
    });

    assert.equal(orchestrator, originalOrchestrator);
    assert.deepEqual(sent, [{ type: "error", message: "Payload must include agentId" }]);
  });

  it("switches agents and prefers the in-memory thread id in the response", () => {
    const sent: unknown[] = [];
    const nextOrchestrator = {
      getActiveAgentId: () => "codex",
      listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
      getThreadId: () => "thread-live",
    } as any;

    const orchestrator = handleSetAgentCommand({
      payload: { agentId: "codex" },
      userId: 7,
      currentCwd: "/tmp/project",
      orchestrator: {} as any,
      sessionManager: {
        switchAgent: () => ({ success: true, message: "ok" }),
        getOrCreate: () => nextOrchestrator,
        getSavedThreadId: () => "thread-saved",
      } as any,
      agentAvailability: {
        mergeStatus: (_agentId: string, status: unknown) => ({ ...(status as object), error: undefined }),
      } as any,
      sendToClient: (payload) => sent.push(payload),
    });

    assert.equal(orchestrator, nextOrchestrator);
    assert.deepEqual(sent, [
      {
        type: "agents",
        activeAgentId: "codex",
        agents: [{ id: "codex", name: "Codex", ready: true, error: undefined }],
        threadId: "thread-live",
      },
    ]);
  });
});
