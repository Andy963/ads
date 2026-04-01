import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { getTaskBundleDraft, listTaskBundleDrafts } from "../../server/web/server/planner/taskBundleDraftStore.js";
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

function ensureSpecFiles(workspaceRoot: string, slug: string): string {
  const specRef = `docs/spec/${slug}`;
  const specDir = path.resolve(workspaceRoot, specRef);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "requirements.md"), "# Requirements\n", "utf8");
  fs.writeFileSync(path.join(specDir, "design.md"), "# Design\n", "utf8");
  fs.writeFileSync(path.join(specDir, "implementation.md"), "# Implementation\n", "utf8");
  return specRef;
}

function createMetrics() {
  return {
    counts: {
      TASK_ADDED: 0,
      TASK_STARTED: 0,
      PROMPT_INJECTED: 0,
      TASK_COMPLETED: 0,
      INJECTION_SKIPPED: 0,
    },
    events: [],
  };
}

function createPlannerPromptDeps(args: {
  payload: unknown;
  requestId: string;
  workspaceRoot: string;
  chatSessionId?: string;
  chatMessages: unknown[];
  clientMessages: unknown[];
  historyStore: MemoryHistoryStore;
  orchestrator: FakeOrchestrator;
  tasks?: Record<string, unknown>;
}) {
  return {
    request: {
      parsed: { type: "prompt" as const, payload: args.payload },
      requestId: args.requestId,
      clientMessageId: null,
      receivedAt: Date.now(),
    },
    transport: {
      ws: {} as any,
      safeJsonSend: (_ws: unknown, payload: unknown) => args.clientMessages.push(payload),
      broadcastJson: (payload: unknown) => args.chatMessages.push(payload),
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
      sessionId: "s",
      chatSessionId: (args.chatSessionId ?? "planner") as const,
      userId: 1,
      historyKey: "h",
      currentCwd: args.workspaceRoot,
    },
    sessions: {
      sessionManager: {
        getOrCreate: () => args.orchestrator as any,
        getSavedThreadId: () => undefined,
        getUserModel: () => "test-model",
        getUserModelReasoningEffort: () => "high",
        getEffectiveState: () => ({ model: "test-model", modelReasoningEffort: "high", activeAgentId: "codex" }),
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        setUserModel: () => {},
        setUserModelReasoningEffort: () => {},
        saveThreadId: () => {},
      } as any,
      orchestrator: args.orchestrator as any,
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map<string, AbortController>(),
    },
    history: {
      historyStore: args.historyStore as any,
    },
    tasks: (args.tasks ?? {}) as any,
    scheduler: {},
  };
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

  it("recovers planner ads-tasks draft when specRef is missing", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator([
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass.",
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
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    ]);

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "add as a task",
        requestId: "req-1",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 2);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿已写入/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0]!.bundle);
    assert.match(String(drafts[0]!.bundle?.specRef ?? ""), /^docs\/spec\//);
    assert.equal(drafts[0]!.requestId, "req:req-1");
    assert.ok(Array.isArray(clientMessages));
  });

  it("persists ads-tasks drafts from the worker lane", async () => {
    const specRef = ensureSpecFiles(workspaceRoot, "worker-draft");
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      [
        "Here is your worker draft.",
        "```ads-tasks",
        JSON.stringify({
          version: 1,
          specRef,
          tasks: [{ title: "Worker Task", prompt: "Do it from worker" }],
        }),
        "```",
      ].join("\n"),
    );

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "create a draft task from worker",
        requestId: "req-worker-draft-1",
        workspaceRoot,
        chatSessionId: "main",
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 1);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿已写入/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.requestId, "req:req-worker-draft-1");
    assert.equal(drafts[0]!.bundle?.tasks[0]?.title, "Worker Task");
    assert.equal(drafts[0]!.bundle?.specRef, specRef);
    assert.ok(Array.isArray(clientMessages));
  });

  it("recovers planner ads-tasks draft when spec directory is missing", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator([
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"specRef":"docs/spec/does-not-exist","tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass.",
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
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    ]);

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "add as a task",
        requestId: "req-2",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 2);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿已写入/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 1);
    assert.ok(Array.isArray(clientMessages));
  });

  it("stops after one recovery attempt when second pass still fails", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator([
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Still broken.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    ]);

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "add as a task",
        requestId: "req-3",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 2);

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

  it("does not retry on non-recoverable spec validation failures", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"specRef":"../escape","tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    );

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "add as a task",
        requestId: "req-4",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 1);

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /任务草稿未写入/);
    assert.match(output, /Invalid specRef/);
    assert.doesNotMatch(output, /```ads-tasks/);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 0);
    assert.ok(Array.isArray(clientMessages));
  });

  it("strips autoApprove during recovery even when passphrase is present", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator([
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass with autoApprove.",
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
        "```ads-tasks",
        '{"version":1,"autoApprove":true,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    ]);

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "ads:autoapprove add as a task",
        requestId: "req-5",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );

    assert.equal(orchestrator.invokeCount, 2);

    const drafts = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0]!.bundle);
    assert.equal(drafts[0]!.bundle?.autoApprove, undefined);
  });

  it("auto-approves drafts with attachment payloads preserved", async () => {
    const specRef = ensureSpecFiles(workspaceRoot, "auto-approve-attachments");
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const sessionPayloads: Array<{ sessionId: string; payload: unknown }> = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      [
        "Auto approve this draft.",
        "```ads-tasks",
        JSON.stringify({
          version: 1,
          autoApprove: true,
          specRef,
          tasks: [{ title: "Task 1", prompt: "Do it", attachments: ["att-1"] }],
        }),
        "```",
      ].join("\n"),
    );

    const tasksById = new Map<string, any>();
    const attachmentsByTaskId = new Map<string, string[]>();
    let setModeAllCalled = 0;
    let resumeCalled = 0;
    let promoteCalled = 0;

    await handlePromptMessage(
      createPlannerPromptDeps({
        payload: "ads:autoapprove add as a task",
        requestId: "req-auto-approve-1",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
        tasks: {
          ensureTaskContext: () => {
            const lock = {
              isBusy: () => false,
              runExclusive: async (fn: () => Promise<void>) => await fn(),
        };
        return {
          workspaceRoot,
          sessionId: "planner-session",
          getLock: () => lock,
          taskStore: {
            createTask(input: { id: string; prompt: string; title?: string }, now: number, opts: { status: string }) {
              if (tasksById.has(input.id)) {
                throw new Error("duplicate");
              }
              const task = {
                id: input.id,
                title: input.title ?? "",
                prompt: input.prompt,
                model: "auto",
                status: opts.status,
                priority: 0,
                queueOrder: 0,
                inheritContext: true,
                agentId: null,
                retryCount: 0,
                maxRetries: 0,
                reviewRequired: true,
                reviewStatus: "pending",
                createdAt: now,
              };
              tasksById.set(task.id, task);
              return task;
            },
            getTask(id: string) {
              return tasksById.get(id) ?? null;
            },
            deleteTask(id: string) {
              tasksById.delete(id);
            },
          },
          attachmentStore: {
            assignAttachmentsToTask(taskId: string, ids: string[]) {
              attachmentsByTaskId.set(taskId, ids.slice());
            },
            listAttachmentsForTask(taskId: string) {
              return (attachmentsByTaskId.get(taskId) ?? []).map((id) => ({
                id,
                taskId,
                kind: "image" as const,
                filename: "diagram.png",
                contentType: "image/png",
                sizeBytes: 12,
                width: 2,
                height: 3,
                sha256: "a".repeat(64),
                storageKey: `attachments/${id}`,
                createdAt: 1,
              }));
            },
          },
          taskQueue: { resume: () => void (resumeCalled += 1) },
          reviewStore: {} as any,
          queueAutoStart: false,
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: { setModeAll: () => void (setModeAllCalled += 1) },
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
            } as any;
          },
          promoteQueuedTasksToPending: () => {
            promoteCalled += 1;
          },
          broadcastToSession: (sessionId: string, payload: unknown) => {
            sessionPayloads.push({ sessionId, payload });
          },
        },
      }),
    );

    const autoApproved = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "task_bundle_auto_approved");
    assert.ok(autoApproved);
    const autoApprovedPayload = autoApproved as { draftId: string; createdTaskIds: string[] };
    const approvedDraft = getTaskBundleDraft({
      authUserId: "test-user",
      draftId: autoApprovedPayload.draftId,
    });
    assert.ok(approvedDraft);
    assert.equal(approvedDraft.status, "approved");
    assert.deepEqual(approvedDraft.approvedTaskIds, autoApprovedPayload.createdTaskIds);
    assert.equal(setModeAllCalled, 1);
    assert.equal(resumeCalled, 1);
    assert.equal(promoteCalled, 1);

    const taskUpdated = sessionPayloads.find((entry) => {
      if (!entry.payload || typeof entry.payload !== "object") return false;
      const rec = entry.payload as { type?: unknown; event?: unknown };
      return rec.type === "task:event" && rec.event === "task:updated";
    });
    assert.ok(taskUpdated);
    const updatedData = (taskUpdated!.payload as { data?: { attachments?: Array<{ id: string; url: string; filename?: string | null }> } }).data;
    assert.ok(updatedData);
    assert.equal(updatedData.attachments?.length, 1);
    assert.equal(updatedData.attachments?.[0]?.id, "att-1");
    assert.equal(updatedData.attachments?.[0]?.filename, "diagram.png");
    assert.equal(
      updatedData.attachments?.[0]?.url,
      `/api/attachments/att-1/raw?workspace=${encodeURIComponent(workspaceRoot)}`,
    );
    assert.ok(Array.isArray(clientMessages));
  });

  it("keeps idempotency for the same requestId across retries", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator([
      [
        "Here is your draft.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass.",
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
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Here is your draft again.",
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
      [
        "Recovery pass again.",
        "<<<spec",
        [
          'title: "My Spec 2"',
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
        "```ads-tasks",
        '{"version":1,"tasks":[{"title":"Task 1","prompt":"Do it"}]}',
        "```",
      ].join("\n"),
    ]);

    const makeDeps = () =>
      createPlannerPromptDeps({
        payload: "add as a task",
        requestId: "req-6",
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      });

    await handlePromptMessage(makeDeps());

    const afterFirst = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(afterFirst.length, 1);
    const firstDraftId = afterFirst[0]!.id;

    await handlePromptMessage(makeDeps());

    assert.equal(orchestrator.invokeCount, 4);

    const afterSecond = listTaskBundleDrafts({
      authUserId: "test-user",
      workspaceRoot,
      limit: 10,
    });
    assert.equal(afterSecond.length, 1);
    assert.equal(afterSecond[0]!.id, firstDraftId);
  });
});
