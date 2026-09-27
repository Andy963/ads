import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildHistoryBootstrapPayload } from "../../server/web/server/ws/bootstrapReplay.js";
import { abortInFlightHistory } from "../../server/web/server/ws/connectionRuntime.js";
import { formatWriteExploredSummary, handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

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

class SlowOrchestrator {
  workingDirectory = "";
  private resolveInvoke: ((value: { response: string; usage: null; agentId: string }) => void) | null = null;
  private readonly startedPromise: Promise<void>;
  private startedResolve: (() => void) | null = null;

  constructor(private readonly threadId: string) {
    this.startedPromise = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  status(): { ready: boolean; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd;
  }

  setModel(): void {}

  setModelReasoningEffort(): void {}

  getActiveAgentId(): string {
    return "codex";
  }

  listAgents(): Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }> {
    return [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }];
  }

  hasAgent(agentId: string): boolean {
    return agentId === "codex";
  }

  onEvent(): () => void {
    return () => undefined;
  }

  getThreadId(): string {
    return this.threadId;
  }

  async invokeAgent(_agentId: string, _input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.startedResolve?.();
    return await new Promise<{ response: string; usage: null; agentId: string }>((resolve) => {
      this.resolveInvoke = resolve;
    });
  }

  waitForStart(): Promise<void> {
    return this.startedPromise;
  }

  resolveLate(response: string): void {
    this.resolveInvoke?.({ response, usage: null, agentId: "codex" });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PromptFixture {
  workspaceRoot: string;
  clientMessages: unknown[];
  chatMessages: unknown[];
  historyStore: MemoryHistoryStore;
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs: Map<string, number>;
  buildArgs: (overrides: {
    parsed: unknown;
    sessionManager?: unknown;
    orchestrator?: unknown;
  }) => Record<string, unknown>;
  cleanup: () => void;
}

function createPromptFixture(tmpPrefix: string): PromptFixture {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const clientMessages: unknown[] = [];
  const chatMessages: unknown[] = [];
  const historyStore = new MemoryHistoryStore();
  const interruptControllers = new Map<string, AbortController>();
  const promptRunEpochs = new Map<string, number>();

  const buildArgs: PromptFixture["buildArgs"] = (overrides) => ({
    request: {
      parsed: overrides.parsed,
      requestId: "req-1",
      clientMessageId: null,
      receivedAt: 123,
    },
    transport: {
      ws: {} as any,
      safeJsonSend: (_ws: unknown, payload: unknown) => clientMessages.push(payload),
      broadcastJson: (payload: unknown) => chatMessages.push(payload),
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
      sessionManager: overrides.sessionManager ?? {},
      orchestrator: overrides.orchestrator ?? {},
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }),
      interruptControllers,
      promptRunEpochs,
    },
    history: {
      historyStore,
    },
    tasks: {},
    scheduler: {},
  });

  const cleanup = () => {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { workspaceRoot, clientMessages, chatMessages, historyStore, interruptControllers, promptRunEpochs, buildArgs, cleanup };
}

describe("web/server/ws handlePrompt cancellation", () => {
  let fixture: PromptFixture;

  beforeEach(() => {
    fixture = createPromptFixture("ads-web-prompt-cancel-");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("interrupt records the abort status without writing late output or thread state", async () => {
    const { clientMessages, chatMessages, historyStore, interruptControllers, promptRunEpochs } = fixture;
    const saveThreadIdCalls: Array<{ userId: number; threadId: string; agentId: string }> = [];
    const orchestrator = new SlowOrchestrator("late-thread");

    const pending = handlePromptMessage(
      fixture.buildArgs({
        parsed: { type: "prompt", payload: "hello" },
        orchestrator: orchestrator as any,
        sessionManager: {
          getOrCreate: () => orchestrator as any,
          getSavedThreadId: () => undefined,
          getEffectiveState: () => ({ model: "test-model", modelReasoningEffort: "high", activeAgentId: "codex" }),
          needsHistoryInjection: () => false,
          clearHistoryInjection: () => {},
          saveThreadId: (userId: number, threadId: string, agentId: string) =>
            saveThreadIdCalls.push({ userId, threadId, agentId }),
          setUserModel: () => {},
          setUserModelReasoningEffort: () => {},
        } as any,
      }) as any,
    );

    await orchestrator.waitForStart();
    assert.equal(
      abortInFlightHistory({
        interruptControllers,
        promptRunEpochs,
        historyKey: "history-1",
      }),
      true,
    );

    const settled = await Promise.race([pending.then(() => "done"), delay(200).then(() => "timeout")]);
    assert.equal(settled, "done");

    orchestrator.resolveLate("late output that must be ignored");
    await delay(0);

    assert.ok(chatMessages.some((msg) => (msg as { type?: unknown; message?: unknown }).message === "已中断，输出可能不完整"));
    assert.equal(
      chatMessages.some(
        (msg) =>
          (msg as { type?: unknown; output?: unknown }).type === "result" &&
          (msg as { output?: unknown }).output === "late output that must be ignored",
      ),
      false,
    );
    assert.deepEqual(saveThreadIdCalls, []);
    assert.deepEqual(
      historyStore.get("history-1").map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
      [
        { role: "user", text: "hello", kind: undefined },
        { role: "status", text: "已中断，输出可能不完整", kind: "error" },
      ],
    );
    assert.equal(clientMessages.length, 0);
  });
});

describe("web/server/ws handlePrompt input errors", () => {
  let fixture: PromptFixture;

  beforeEach(() => {
    fixture = createPromptFixture("ads-web-prompt-input-error-");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("persists prompt input failures so reconnect history explains the failed turn", async () => {
    const { clientMessages, chatMessages, historyStore } = fixture;

    const result = await handlePromptMessage(
      fixture.buildArgs({
        parsed: {
          type: "prompt",
          payload: {
            text: "hello",
            images: [{ name: "bad.txt", mime: "text/plain", data: "abc" }],
          },
        },
      }) as any,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(clientMessages, []);
    assert.deepEqual(chatMessages, [{ type: "error", message: "不支持的图片类型: text/plain" }]);
    assert.deepEqual(
      historyStore.get("history-1").map((entry) => ({
        role: entry.role,
        text: entry.text,
        kind: entry.kind,
      })),
      [{ role: "status", text: "不支持的图片类型: text/plain", kind: "error" }],
    );
    assert.deepEqual(buildHistoryBootstrapPayload(historyStore.get("history-1"))?.items, historyStore.get("history-1"));
  });
});

describe("web/server/ws handlePrompt not-ready agents", () => {
  let fixture: PromptFixture;
  let orchestrator: NotReadyOrchestrator;

  beforeEach(() => {
    fixture = createPromptFixture("ads-web-prompt-not-ready-");
    orchestrator = new NotReadyOrchestrator();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("persists prompt agent override failures so reconnect history shows the failed turn", async () => {
    const { clientMessages, chatMessages, historyStore } = fixture;

    const result = await handlePromptMessage(
      fixture.buildArgs({
        parsed: { type: "prompt", payload: { text: "hello", agentId: "missing" } },
        orchestrator,
        sessionManager: {
          getOrCreate: () => orchestrator,
          switchAgent: (_userId: number, agentId: string) => ({
            success: false,
            message: `Agent "${agentId}" is not registered`,
          }),
          getSavedThreadId: () => undefined,
          needsHistoryInjection: () => false,
          clearHistoryInjection: () => {},
        },
      }) as any,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(clientMessages, []);
    assert.deepEqual(chatMessages, [{ type: "error", message: 'Agent "missing" is not registered' }]);
    assert.deepEqual(
      historyStore.get("history-1").map((entry) => ({
        role: entry.role,
        text: entry.text,
        kind: entry.kind,
      })),
      [
        { role: "user", text: "hello", kind: undefined },
        { role: "status", text: 'Agent "missing" is not registered', kind: "error" },
      ],
    );
  });

  it("persists the agent readiness failure so reconnect history shows the failed turn", async () => {
    const { clientMessages, chatMessages, historyStore } = fixture;

    const result = await handlePromptMessage(
      fixture.buildArgs({
        parsed: { type: "prompt", payload: { text: "hello", agentId: "claude" } },
        orchestrator,
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
      }) as any,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(clientMessages, []);
    assert.deepEqual(chatMessages, [{ type: "error", message: "Claude credentials are missing" }]);
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
  });
});

describe("web/server/ws/handlePrompt Write summary", () => {
  it("appends a git-style diffstat when patch stats are available", () => {
    const longPath = `${"a/".repeat(40)}file.txt`;
    const changes = [
      { kind: "modify", path: longPath },
      { kind: "create", path: "src/short.ts" },
      { kind: "modify", path: "src/third.ts" },
      { kind: "delete", path: "src/fourth.ts" },
      { kind: "modify", path: "src/fifth.ts" },
    ];
    const patchFiles = [
      { path: "src/short.ts", added: 5, removed: 1 },
      { path: "src/third.ts", added: 2, removed: 0 },
    ];

    const summary = formatWriteExploredSummary(changes, patchFiles);

    assert.ok(summary.includes("modify file.txt"), summary);
    assert.ok(summary.includes("(+1 more)"), summary);
    assert.ok(summary.endsWith("(+7 -1)"), summary);
  });
});
