import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { listTaskBundleDrafts } from "../../src/web/server/planner/taskBundleDraftStore.js";
import { handlePromptMessage } from "../../src/web/server/ws/handlePrompt.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    const list = this.store.get(sessionId) ?? [];
    list.push(entry);
    this.store.set(sessionId, list);
    return true;
  }
}

class FakeOrchestrator {
  private readonly responseText: string;
  lastInvokeInput: unknown = null;

  constructor(responseText: string) {
    this.responseText = responseText;
  }

  status(): { ready: boolean; error?: string; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(_workingDirectory?: string): void {
    // noop
  }

  getActiveAgentId(): string {
    return "codex";
  }

  listAgents(): Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean; error?: string } }> {
    return [
      {
        metadata: { id: "codex", name: "Codex" },
        status: { ready: true, streaming: true },
      },
    ];
  }

  hasAgent(agentId: string): boolean {
    return agentId === "codex";
  }

  onEvent(_handler: (event: unknown) => void): () => void {
    return () => undefined;
  }

  async invokeAgent(agentId: string, input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.lastInvokeInput = input;
    return { response: this.responseText, usage: null, agentId };
  }

  getThreadId(): string {
    return "thread-test";
  }
}

describe("web/ws/planner-draft-spec-guard", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-planner-spec-guard-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-planner-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("rejects planner ads-tasks draft when specRef is missing", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    );

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "add as a task" },
      ws: {} as any,
      safeJsonSend: (_ws, payload) => clientMessages.push(payload),
      broadcastJson: (payload) => chatMessages.push(payload),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: () => {},
        logEvent: () => {},
        attachThreadId: () => {},
      },
      requestId: "req-1",
      clientMessageId: null,
      traceWsDuplication: false,
      receivedAt: Date.now(),
      authUserId: "test-user",
      sessionId: "s",
      chatSessionId: "planner",
      userId: 1,
      historyKey: "h",
      currentCwd: workspaceRoot,
      allowedDirs: [workspaceRoot],
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map(),
      historyStore: historyStore as any,
      sessionManager: {
        getOrCreate: () => orchestrator as any,
        getSavedThreadId: () => undefined,
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        saveThreadId: () => {},
      } as any,
      orchestrator: orchestrator as any,
      sendWorkspaceState: () => {},
    });

    const draftUpserts = chatMessages.filter((message) => {
      if (!message || typeof message !== "object") return false;
      const rec = message as { type?: unknown; action?: unknown };
      return rec.type === "task_bundle_draft" && rec.action === "upsert";
    });
    assert.equal(draftUpserts.length, 0);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿未写入/);
    assert.match(output, /spec is required before draft/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 0);
    assert.ok(Array.isArray(clientMessages));
  });

  it("rejects planner ads-tasks draft when spec directory is missing", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"specRef":"docs/spec/does-not-exist","tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    );

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "add as a task" },
      ws: {} as any,
      safeJsonSend: (_ws, payload) => clientMessages.push(payload),
      broadcastJson: (payload) => chatMessages.push(payload),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: () => {},
        logEvent: () => {},
        attachThreadId: () => {},
      },
      requestId: "req-2",
      clientMessageId: null,
      traceWsDuplication: false,
      receivedAt: Date.now(),
      authUserId: "test-user",
      sessionId: "s",
      chatSessionId: "planner",
      userId: 1,
      historyKey: "h",
      currentCwd: workspaceRoot,
      allowedDirs: [workspaceRoot],
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map(),
      historyStore: historyStore as any,
      sessionManager: {
        getOrCreate: () => orchestrator as any,
        getSavedThreadId: () => undefined,
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        saveThreadId: () => {},
      } as any,
      orchestrator: orchestrator as any,
      sendWorkspaceState: () => {},
    });

    const draftUpserts = chatMessages.filter((message) => {
      if (!message || typeof message !== "object") return false;
      const rec = message as { type?: unknown; action?: unknown };
      return rec.type === "task_bundle_draft" && rec.action === "upsert";
    });
    assert.equal(draftUpserts.length, 0);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿未写入/);
    assert.match(output, /Spec directory not found: docs\/spec\/does-not-exist/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 0);
    assert.ok(Array.isArray(clientMessages));
  });
});
