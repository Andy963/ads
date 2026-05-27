import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    this.store.set(sessionId, [...this.get(sessionId), entry]);
    return true;
  }
}

class NotReadyOrchestrator {
  setWorkingDirectory(): void {}

  status(): { ready: boolean; streaming: boolean; error: string } {
    return { ready: false, streaming: false, error: "Claude credentials are missing" };
  }

  getActiveAgentId(): string {
    return "claude";
  }
}

describe("web/server/ws handlePrompt not-ready agents", () => {
  it("persists the agent readiness failure so reconnect history shows the failed turn", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-prompt-not-ready-"));
    const historyStore = new MemoryHistoryStore();
    const clientMessages: unknown[] = [];
    const orchestrator = new NotReadyOrchestrator();

    try {
      const result = await handlePromptMessage({
        request: {
          parsed: { type: "prompt", payload: { text: "hello", agentId: "claude" } },
          requestId: "req-1",
          clientMessageId: null,
          receivedAt: 123,
        },
        transport: {
          ws: {} as any,
          safeJsonSend: (_ws, payload) => clientMessages.push(payload),
          broadcastJson: () => {},
          sendWorkspaceState: () => {},
        },
        observability: {
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
          sessionLogger: {
            logInput: () => {},
            logOutput: () => {},
            logError: () => {},
            logEvent: () => {},
            attachThreadId: () => {},
          },
          traceWsDuplication: false,
        },
        context: {
          authUserId: "test-user",
          sessionId: "session-1",
          chatSessionId: "main",
          userId: 1,
          historyKey: "history-1",
          currentCwd: workspaceRoot,
        },
        sessions: {
          sessionManager: {
            getOrCreate: () => orchestrator,
            switchAgent: (_userId: number, agentId: string) => ({
              success: agentId === "claude",
              message: agentId === "claude" ? "ok" : `Agent "${agentId}" is not registered`,
            }),
            getSavedThreadId: () => undefined,
            needsHistoryInjection: () => false,
            clearHistoryInjection: () => {},
          },
          orchestrator,
          getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }),
          interruptControllers: new Map<string, AbortController>(),
          promptRunEpochs: new Map<string, number>(),
        },
        history: {
          historyStore,
        },
        tasks: {},
        scheduler: {},
      } as any);

      assert.equal(result.handled, true);
      assert.deepEqual(clientMessages, [{ type: "error", message: "Claude credentials are missing" }]);
      assert.deepEqual(
        historyStore.get("history-1").map((entry) => ({
          role: entry.role,
          text: entry.text,
          kind: entry.kind,
        })),
        [
          { role: "user", text: "hello", kind: undefined },
          { role: "status", text: "Claude credentials are missing", kind: "error" },
        ],
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
