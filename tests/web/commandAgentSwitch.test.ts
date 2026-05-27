import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { handleSetAgentCommand } from "../../server/web/server/ws/commandAgentSwitch.js";

describe("web/ws/commandAgentSwitch", () => {
  it("rejects payloads without agentId and records the error for reconnect replay", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-agent-switch-missing", maxEntriesPerSession: 10 });
    const originalOrchestrator = { id: "original" } as any;

    try {
      const orchestrator = handleSetAgentCommand({
        payload: {},
        userId: 7,
        historyKey: "history-missing-agent",
        currentCwd: "/tmp/project",
        orchestrator: originalOrchestrator,
        sessionManager: {} as any,
        historyStore,
        agentAvailability: {} as any,
        sendToClient: (payload) => sent.push(payload),
      });

      assert.equal(orchestrator, originalOrchestrator);
      assert.deepEqual(sent, [{ type: "error", message: "Payload must include agentId" }]);
      assert.deepEqual(
        historyStore
          .get("history-missing-agent")
          .map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "Payload must include agentId", kind: "error" }],
      );
    } finally {
      historyStore.clear("history-missing-agent");
    }
  });

  it("records rejected agent switches for reconnect replay", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-agent-switch-rejected", maxEntriesPerSession: 10 });
    const originalOrchestrator = { id: "original" } as any;

    try {
      const orchestrator = handleSetAgentCommand({
        payload: { agentId: "claude" },
        userId: 7,
        historyKey: "history-rejected-agent",
        currentCwd: "/tmp/project",
        orchestrator: originalOrchestrator,
        sessionManager: {
          switchAgent: () => ({ success: false, message: 'Agent "claude" is not registered' }),
        } as any,
        historyStore,
        agentAvailability: {} as any,
        sendToClient: (payload) => sent.push(payload),
      });

      assert.equal(orchestrator, originalOrchestrator);
      assert.deepEqual(sent, [{ type: "error", message: 'Agent "claude" is not registered' }]);
      assert.deepEqual(
        historyStore
          .get("history-rejected-agent")
          .map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: 'Agent "claude" is not registered', kind: "error" }],
      );
    } finally {
      historyStore.clear("history-rejected-agent");
    }
  });

  it("switches agents and prefers the in-memory thread id in the response", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-agent-switch-ok", maxEntriesPerSession: 10 });
    let recreatedWithResumeThread: boolean | undefined;
    const nextOrchestrator = {
      getActiveAgentId: () => "codex",
      listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
      getThreadId: () => "thread-live",
    } as any;

    try {
      const orchestrator = handleSetAgentCommand({
        payload: { agentId: "codex" },
        userId: 7,
        historyKey: "history-agent-ok",
        currentCwd: "/tmp/project",
        orchestrator: {} as any,
        sessionManager: {
          hasSession: () => false,
          switchAgent: () => ({ success: true, message: "ok" }),
          getOrCreate: (_userId: number, _cwd?: string, resumeThread?: boolean) => {
            recreatedWithResumeThread = resumeThread;
            return nextOrchestrator;
          },
          getSavedThreadId: () => "thread-saved",
        } as any,
        historyStore,
        agentAvailability: {
          mergeStatus: (_agentId: string, status: unknown) => ({ ...(status as object), error: undefined }),
        } as any,
        sendToClient: (payload) => sent.push(payload),
      });

      assert.equal(orchestrator, nextOrchestrator);
      assert.equal(recreatedWithResumeThread, true);
      assert.deepEqual(sent, [
        {
          type: "agents",
          activeAgentId: "codex",
          agents: [{ id: "codex", name: "Codex", ready: true, error: undefined }],
          threadId: "thread-live",
        },
        { type: "status", message: "已切换到代理: Codex", kind: "status" },
      ]);
      assert.deepEqual(
        historyStore
          .get("history-agent-ok")
          .map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "已切换到代理: Codex", kind: "status" }],
      );
    } finally {
      historyStore.clear("history-agent-ok");
    }
  });
});
