import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";
import { handleWsControlMessage } from "../../server/web/server/ws/messageControl.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    const next = [...this.get(sessionId), entry];
    this.store.set(sessionId, next);
    return true;
  }

  clear(sessionId: string): void {
    this.store.delete(sessionId);
  }
}

class FakeReviewerOrchestrator {
  invokeCount = 0;
  workingDirectory = "";
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
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
    return "reviewer-thread";
  }

  async invokeAgent(_agentId: string, _input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.invokeCount += 1;
    const response = this.responses.shift() ?? "default analysis";
    return { response, usage: null, agentId: "codex" };
  }
}

class SlowReviewerOrchestrator {
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

function createDeps(args: {
  orchestrator: FakeReviewerOrchestrator;
  historyStore: MemoryHistoryStore;
  reviewStore: ReviewStore;
  reviewerSnapshotBindings: Map<string, string>;
  payload: unknown;
  sessionManagerOverrides?: Record<string, unknown>;
}) {
  const chatMessages: unknown[] = [];
  const clientMessages: unknown[] = [];

  return {
    chatMessages,
    clientMessages,
    deps: {
      request: {
        parsed: { type: "prompt" as const, payload: args.payload },
        requestId: `req-${Date.now()}`,
        clientMessageId: null,
        receivedAt: Date.now(),
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
        chatSessionId: "reviewer",
        userId: 1,
        historyKey: "hist-1",
        currentCwd: process.cwd(),
      },
      sessions: {
        sessionManager: {
          hasSession: () => true,
          getOrCreate: () => args.orchestrator as any,
          getSavedThreadId: () => undefined,
          getSavedReviewerSnapshotId: () => undefined,
          reset: () => {},
          getUserModel: () => "test-model",
          getUserModelReasoningEffort: () => "high",
          getEffectiveState: () => ({ model: "test-model", modelReasoningEffort: "high", activeAgentId: "codex" }),
          needsHistoryInjection: () => false,
          clearHistoryInjection: () => {},
          saveReviewerSnapshotBinding: () => {},
          clearSavedReviewerSnapshotBinding: () => {},
          setUserModel: () => {},
          setUserModelReasoningEffort: () => {},
          saveThreadId: () => {},
          ...(args.sessionManagerOverrides ?? {}),
        } as any,
        orchestrator: args.orchestrator as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
        interruptControllers: new Map<string, AbortController>(),
      },
      history: {
        historyStore: args.historyStore as any,
      },
      tasks: {
        ensureTaskContext: () => ({ reviewStore: args.reviewStore }) as any,
      },
      scheduler: {},
      reviewerSnapshotBindings: args.reviewerSnapshotBindings,
    } as any,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("web reviewer prompt flow", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let originalCwd: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-reviewer-prompt-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-reviewer-workspace-"));
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetDatabaseForTests();
    process.chdir(workspaceRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetDatabaseForTests();
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

  it("accepts reviewer prompts, denies write-like requests, and preserves continuity with artifacts", async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const reviewStore = new ReviewStore();
    const snapshot = reviewStore.createSnapshot({
      taskId: task.id,
      specRef: null,
      worktreeDir: workspaceRoot,
      patch: { files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+ok\n", truncated: false },
      changedFiles: ["src/a.ts"],
      lintSummary: "",
      testSummary: "",
    });
    const historyStore = new MemoryHistoryStore();
    const reviewerSnapshotBindings = new Map<string, string>();
    const orchestrator = new FakeReviewerOrchestrator([
      "First analytical review.",
      "Second analytical review after denial.",
    ]);

    const first = createDeps({
      orchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: { text: "Please review this snapshot", snapshotId: snapshot.id },
    });
    await handlePromptMessage(first.deps);

    const firstResult = first.chatMessages.find((message) => (message as { type?: unknown }).type === "result") as
      | { output?: unknown }
      | undefined;
    assert.equal(String(firstResult?.output ?? ""), "First analytical review.");
    assert.equal(orchestrator.invokeCount, 1);

    const firstArtifacts = reviewStore.listArtifacts({ snapshotId: snapshot.id, limit: 10 });
    assert.equal(firstArtifacts.length, 1);
    assert.equal(firstArtifacts[0]?.snapshotId, snapshot.id);
    assert.equal(orchestrator.workingDirectory, workspaceRoot);
    assert.equal(reviewerSnapshotBindings.get("hist-1"), snapshot.id);

    const denied = createDeps({
      orchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: "Please write the patch and update the file for me",
    });
    await handlePromptMessage(denied.deps);
    const deniedResult = denied.chatMessages.find((message) => (message as { type?: unknown }).type === "result") as
      | { output?: unknown }
      | undefined;
    assert.match(String(deniedResult?.output ?? ""), /Reviewer stays read-only/);
    assert.equal(orchestrator.invokeCount, 1);
    assert.equal(reviewStore.listArtifacts({ snapshotId: snapshot.id, limit: 10 }).length, 1);

    const followUp = createDeps({
      orchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: "Give me one more analytical concern",
    });
    await handlePromptMessage(followUp.deps);
    const followUpResult = followUp.chatMessages.find((message) => (message as { type?: unknown }).type === "result") as
      | { output?: unknown }
      | undefined;
    assert.equal(String(followUpResult?.output ?? ""), "Second analytical review after denial.");
    assert.equal(orchestrator.invokeCount, 2);

    const artifacts = reviewStore.listArtifacts({ snapshotId: snapshot.id, limit: 10 });
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0]?.priorArtifactId, artifacts[1]?.id ?? null);
    assert.equal(artifacts[0]?.snapshotId, snapshot.id);

    const history = historyStore.get("hist-1");
    assert.deepEqual(
      history.map((entry) => entry.role),
      ["user", "ai", "user", "ai", "user", "ai"],
    );
    assert.match(history[3]?.text ?? "", /Reviewer stays read-only/);
  });

  it("resumes reviewer continuity when a recreated session receives an explicit snapshot-bound prompt", async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const reviewStore = new ReviewStore();
    const snapshot = reviewStore.createSnapshot({
      taskId: task.id,
      specRef: null,
      worktreeDir: workspaceRoot,
      patch: { files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+ok\n", truncated: false },
      changedFiles: ["src/a.ts"],
      lintSummary: "",
      testSummary: "",
    });
    const historyStore = new MemoryHistoryStore();
    const reviewerSnapshotBindings = new Map<string, string>();
    const orchestrator = new FakeReviewerOrchestrator(["Resumed analytical review."]);
    const getOrCreateCalls: Array<{ userId: number; cwd?: string; resumeThread?: boolean }> = [];

    const prompt = createDeps({
      orchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: { text: "Resume reviewer context for this snapshot", snapshotId: snapshot.id },
      sessionManagerOverrides: {
        hasSession: () => false,
        getOrCreate: (userId: number, cwd?: string, resumeThread?: boolean) => {
          getOrCreateCalls.push({ userId, cwd, resumeThread });
          return orchestrator as any;
        },
      },
    });
    await handlePromptMessage(prompt.deps);

    const result = prompt.chatMessages.find((message) => (message as { type?: unknown }).type === "result") as
      | { output?: unknown }
      | undefined;
    assert.equal(String(result?.output ?? ""), "Resumed analytical review.");
    assert.deepEqual(getOrCreateCalls, [{ userId: 1, cwd: workspaceRoot, resumeThread: true }]);
    assert.equal(reviewerSnapshotBindings.get("hist-1"), snapshot.id);
  });

  it("rejects reviewer prompts without an explicit or previously bound snapshot", async () => {
    const taskStore = new TaskStore();
    taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const reviewStore = new ReviewStore();
    const historyStore = new MemoryHistoryStore();
    const reviewerSnapshotBindings = new Map<string, string>();
    const orchestrator = new FakeReviewerOrchestrator(["unused"]);

    const first = createDeps({
      orchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: "Please review this snapshot",
    });
    await handlePromptMessage(first.deps);

    const firstResult = first.chatMessages.find((message) => (message as { type?: unknown }).type === "result") as
      | { output?: unknown }
      | undefined;
    assert.match(String(firstResult?.output ?? ""), /needs an explicit snapshotId/);
    assert.equal(orchestrator.invokeCount, 0);
  });

  it("clear_history makes late reviewer completion unable to write back artifacts, history, or thread state", async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const reviewStore = new ReviewStore();
    const snapshot = reviewStore.createSnapshot({
      taskId: task.id,
      specRef: null,
      worktreeDir: workspaceRoot,
      patch: { files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+ok\n", truncated: false },
      changedFiles: ["src/a.ts"],
      lintSummary: "",
      testSummary: "",
    });
    const historyStore = new MemoryHistoryStore();
    const reviewerSnapshotBindings = new Map<string, string>();
    const orchestrator = new SlowReviewerOrchestrator("reviewer-late-thread");
    const saveThreadIdCalls: Array<{ userId: number; threadId: string; agentId: string }> = [];
    const clearResults: unknown[] = [];

    const prompt = createDeps({
      orchestrator: orchestrator as unknown as FakeReviewerOrchestrator,
      historyStore,
      reviewStore,
      reviewerSnapshotBindings,
      payload: { text: "Please review this snapshot", snapshotId: snapshot.id },
      sessionManagerOverrides: {
        saveThreadId: (userId: number, threadId: string, agentId: string) =>
          saveThreadIdCalls.push({ userId, threadId, agentId }),
      },
    });
    prompt.deps.sessions.promptRunEpochs = new Map<string, number>();

    const pending = handlePromptMessage(prompt.deps);
    await orchestrator.waitForStart();

    await handleWsControlMessage({
      parsed: { type: "clear_history" },
      isReviewerChat: true,
      userId: 1,
      historyKey: "hist-1",
      currentCwd: workspaceRoot,
      sessionManager: prompt.deps.sessions.sessionManager,
      orchestrator: prompt.deps.sessions.orchestrator,
      getWorkspaceLock: prompt.deps.sessions.getWorkspaceLock,
      historyStore: prompt.deps.history.historyStore,
      interruptControllers: prompt.deps.sessions.interruptControllers,
      promptRunEpochs: prompt.deps.sessions.promptRunEpochs,
      reviewerSnapshotBindings,
      ensureTaskContext: prompt.deps.tasks.ensureTaskContext,
      sendJson: (payload) => clearResults.push(payload),
      logger: { info: () => {}, warn: () => {} },
    });

    const settled = await Promise.race([
      pending.then(() => "done"),
      delay(200).then(() => "timeout"),
    ]);
    assert.equal(settled, "done");

    orchestrator.resolveLate("Late reviewer output");
    await delay(0);

    assert.ok(prompt.chatMessages.some((message) => (message as { message?: unknown }).message === "已中断，输出可能不完整"));
    assert.equal(
      prompt.chatMessages.some(
        (message) =>
          (message as { type?: unknown; output?: unknown }).type === "result" &&
          (message as { output?: unknown }).output === "Late reviewer output",
      ),
      false,
    );
    assert.equal(
      prompt.chatMessages.some((message) => (message as { type?: unknown }).type === "reviewer_artifact"),
      false,
    );
    assert.equal(reviewStore.listArtifacts({ snapshotId: snapshot.id, limit: 10 }).length, 0);
    assert.deepEqual(saveThreadIdCalls, []);
    assert.deepEqual(historyStore.get("hist-1"), []);
    assert.deepEqual(clearResults, [
      {
        type: "result",
        ok: true,
        output: "已清空历史缓存并重置会话",
        kind: "clear_history",
      },
    ]);
  });
});
