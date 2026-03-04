import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { listTaskBundleDrafts } from "../../server/web/server/planner/taskBundleDraftStore.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

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
  private readonly responseTexts: string[];
  invokeCount = 0;
  invokeInputs: unknown[] = [];

  constructor(responseTexts: string | string[]) {
    this.responseTexts = Array.isArray(responseTexts) ? responseTexts : [responseTexts];
  }

  status(): { ready: boolean; error?: string; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(_workingDirectory?: string): void {
    // noop
  }

  setModelReasoningEffort(_effort?: string): void {
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
    this.invokeCount += 1;
    this.invokeInputs.push(input);
    const index = Math.min(this.invokeCount - 1, this.responseTexts.length - 1);
    const response = this.responseTexts[index] ?? "";
    return { response, usage: null, agentId };
  }

  getThreadId(): string {
    return "thread-test";
  }
}

function makeSpecBlock(): string {
  return [
    "<<<spec",
    [
      'title: "My Spec"',
      'template_id: "unified"',
      "files:",
      "  requirements.md: |",
      "    # Requirements",
      "    - Goal: do it",
      "  design.md: |",
      "    # Design",
      "    - Approach: simple",
      "  implementation.md: |",
      "    # Implementation",
      "    - Steps: 1) do it",
    ].join("\n"),
    ">>>",
  ].join("\n");
}

describe("web/ws/planner-slash-draft-command", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-planner-slash-draft-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-planner-slash-draft-workspace-"));
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

  it("hard-routes /draft to planner-slash-draft and persists exactly one draft task", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();

    const orchestrator = new FakeOrchestrator(
      [
        "Draft summary.",
        makeSpecBlock(),
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it","inheritContext":true}]}',
        "```",
      ].join("\n"),
    );

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
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
      requestId: "req-draft-1",
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

    assert.equal(orchestrator.invokeCount, 1);
    assert.match(String(orchestrator.invokeInputs[0] ?? ""), /\$planner-slash-draft/);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿已写入/);
    assert.doesNotMatch(output, /```ads-tasks/);
    assert.doesNotMatch(output, /```ads-schedule/);

    const drafts = listTaskBundleDrafts({ authUserId: "test-user", workspaceRoot, limit: 10 });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.requestId, "req:req-draft-1");
    assert.ok(drafts[0]!.bundle);
    assert.equal(drafts[0]!.bundle!.tasks.length, 1);
    assert.equal(drafts[0]!.bundle!.autoApprove, undefined);
  });

  it("retries once on spec guard failure for /draft", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();

    const orchestrator = new FakeOrchestrator([
      [
        "First pass missing spec.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it","inheritContext":true}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass.",
        makeSpecBlock(),
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it","inheritContext":true}]}',
        "```",
      ].join("\n"),
    ]);

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
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
      requestId: "req-draft-2",
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

    assert.equal(orchestrator.invokeCount, 2);

    const drafts = listTaskBundleDrafts({ authUserId: "test-user", workspaceRoot, limit: 10 });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.requestId, "req:req-draft-2");
    assert.ok(drafts[0]!.bundle);
    assert.equal(drafts[0]!.bundle!.tasks.length, 1);
  });

  it("rejects /draft output when tasks.length is not 1", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();

    const orchestrator = new FakeOrchestrator(
      [
        "Draft summary.",
        makeSpecBlock(),
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"},{"title":"Task 2","prompt":"Do it too"}]}',
        "```",
      ].join("\n"),
    );

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
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
      requestId: "req-draft-3",
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

    assert.equal(orchestrator.invokeCount, 1);

	    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
	    assert.ok(result);
	    const output = String((result as { output?: unknown }).output ?? "");
	    assert.match(output, /tasks\.length === 1/);

    const drafts = listTaskBundleDrafts({ authUserId: "test-user", workspaceRoot, limit: 10 });
    assert.equal(drafts.length, 0);
  });

  it("does not compile schedule blocks for /draft (and strips schedule output)", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();

    const orchestrator = new FakeOrchestrator(
      [
        "Draft summary.",
        makeSpecBlock(),
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it","inheritContext":true}]}',
        "```",
        "```ads-schedule",
        '{"name":"should-not-run"}',
        "```",
      ].join("\n"),
    );

    let compileCalls = 0;
    const scheduleCompiler = {
      compile: async () => {
        compileCalls += 1;
        return { name: "X", enabled: false, schedule: { cron: "* * * * *", timezone: "UTC" }, questions: [] };
      },
    };
    const scheduler = { registerWorkspace: () => {} };

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
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
      requestId: "req-draft-4",
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
      scheduleCompiler: scheduleCompiler as any,
      scheduler: scheduler as any,
    });

    assert.equal(compileCalls, 0);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.doesNotMatch(output, /```ads-schedule/);
  });

  it("keeps idempotency for /draft with the same requestId", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();

    const orchestrator = new FakeOrchestrator(
      [
        "Draft summary.",
        makeSpecBlock(),
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it","inheritContext":true}]}',
        "```",
      ].join("\n"),
    );

    const makeDeps = () => ({
      ws: {} as any,
      safeJsonSend: (_ws: any, payload: unknown) => clientMessages.push(payload),
      broadcastJson: (payload: unknown) => chatMessages.push(payload),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: () => {},
        logEvent: () => {},
        attachThreadId: () => {},
      },
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

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
      requestId: "req-draft-5",
      ...makeDeps(),
    });

    const afterFirst = listTaskBundleDrafts({ authUserId: "test-user", workspaceRoot, limit: 10 });
    assert.equal(afterFirst.length, 1);
    const firstDraftId = afterFirst[0]!.id;

    await handlePromptMessage({
      parsed: { type: "prompt", payload: "/draft ship it" },
      requestId: "req-draft-5",
      ...makeDeps(),
    });

    const afterSecond = listTaskBundleDrafts({ authUserId: "test-user", workspaceRoot, limit: 10 });
    assert.equal(afterSecond.length, 1);
    assert.equal(afterSecond[0]!.id, firstDraftId);
  });
});
