import assert from "node:assert/strict";
import { it } from "node:test";

import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";
import type { AgentSendOptions } from "../../server/agents/types.js";

class HistoryStore {
  private readonly entries = new Map<string, Array<{ role: string; text: string; ts: number; kind?: string }>>();

  get(key: string) {
    return this.entries.get(key) ?? [];
  }

  add(key: string, entry: { role: string; text: string; ts: number; kind?: string }) {
    this.entries.set(key, [...this.get(key), entry]);
    return true;
  }
}

class CapturingOrchestrator {
  sendOptions: AgentSendOptions | undefined;

  status() {
    return { ready: true, streaming: false };
  }

  setWorkingDirectory() {}

  getActiveAgentId() {
    return "codex";
  }

  getThreadId() {
    return null;
  }

  onEvent() {
    return () => {};
  }

  async invokeAgent(_agentId: string, _input: unknown, options: AgentSendOptions) {
    this.sendOptions = options;
    return { response: "completed", usage: null, agentId: "codex" };
  }
}

it("passes interactive supervised tools to Actions prompts and disposes them after the turn", async () => {
  const orchestrator = new CapturingOrchestrator();
  const historyStore = new HistoryStore();
  const interruptControllers = new Map<string, AbortController>();
  let disposed = false;
  const actionTools = {
    review_action: async () => ({ ok: true }),
    deliver_action: async () => ({ ok: true }),
    dispose: async () => { disposed = true; },
  };
  const workspaceRoot = process.cwd();

  const result = await handlePromptMessage({
    createInteractiveActionTools: () => actionTools,
    request: {
      parsed: { type: "prompt", payload: "run the reviewed workflow" },
      requestId: "request-1",
      clientMessageId: null,
      receivedAt: Date.now(),
    },
    transport: {
      ws: {} as never,
      safeJsonSend: () => {},
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
      authUserId: "user-1",
      sessionId: "project-1",
      chatSessionId: "main",
      userId: 1,
      historyKey: "history-1",
      currentCwd: workspaceRoot,
    },
    sessions: {
      sessionManager: {
        getOrCreate: () => orchestrator,
        getSavedThreadId: () => undefined,
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        saveThreadId: () => {},
        getEffectiveState: () => ({ model: "test", modelReasoningEffort: "high", activeAgentId: "codex" }),
      } as never,
      orchestrator,
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as never,
      interruptControllers,
    },
    history: { historyStore },
    scheduler: {},
  });

  assert.equal(result.outcome.ok, true);
  assert.equal(orchestrator.sendOptions?.actionTools, actionTools);
  assert.equal(disposed, true);
});
