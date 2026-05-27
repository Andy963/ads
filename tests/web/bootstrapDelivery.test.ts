import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { sendInitialBootstrapMessages } from "../../server/web/server/ws/bootstrapDelivery.js";

describe("web/ws/bootstrapDelivery", () => {
  it("sends welcome, agents, and history in order", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "thread-live",
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal((sent[2] as { type?: unknown }).type, "history");
    } finally {
      historyStore.clear("history-1");
    }
  });
});
