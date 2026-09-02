import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Task } from "../../server/tasks/types.js";
import { defaultTaskReviewSummary } from "../../server/tasks/reviewData.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../server/web/server/api/types.js";
import { handleTaskRoutes } from "../../server/web/server/api/routes/tasks.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createReq(body: unknown): FakeReq {
  const payload = JSON.stringify(body);
  return {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload, "utf8");
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    body: "",
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "source-1",
    title: "Issue #80",
    prompt: "Create PR #85",
    model: "worker-model",
    modelParams: null,
    status: "completed",
    priority: 0,
    category: "development",
    queueOrder: 1,
    queuedAt: null,
    promptInjectedAt: null,
    inheritContext: false,
    agentId: "worker",
    parentTaskId: null,
    threadId: "thread-1",
    result: "Created PR #85",
    error: null,
    retryCount: 0,
    maxRetries: 0,
    nextAttemptAt: null,
    executionIsolation: "default",
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    archivedAt: null,
    createdBy: "test",
    goalMode: false,
    goalObjective: null,
    goalTokenBudget: null,
    goalStatus: null,
    goalTokensUsed: null,
    goalTimeUsedSeconds: null,
    review: defaultTaskReviewSummary({
      required: true,
      status: "pending_review",
      rootTaskId: "source-1",
      pullRequestNumber: 85,
      pullRequestUrl: "https://github.com/acme/project/pull/85",
      reviewTaskId: "review-1",
      reviewerModelId: "reviewer-model",
      reviewerModelDisplayName: "Reviewer",
      reviewerAgentId: "reviewer",
    }),
    latestRun: null,
    ...overrides,
  };
}

function createHarness() {
  const tasks = new Map<string, Task>();
  const source = makeTask({ id: "source-1" });
  const review = makeTask({
    id: "review-1",
    title: "Review PR #85",
    prompt: "Review the pull request",
    model: "reviewer-model",
    agentId: "reviewer",
    status: "pending",
    category: "review",
    parentTaskId: source.id,
    review: defaultTaskReviewSummary({ ...source.review, rootTaskId: source.id }),
  });
  tasks.set(source.id, source);
  tasks.set(review.id, review);
  const audits: Array<Record<string, unknown>> = [];
  let reworkCounter = 0;
  const taskStore = {
    getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    getRootTask(id: string) {
      let current = tasks.get(id) ?? null;
      while (current?.parentTaskId) current = tasks.get(current.parentTaskId) ?? current;
      return current;
    },
    listChildTasks(parentTaskId: string) {
      return [...tasks.values()].filter((task) => task.parentTaskId === parentTaskId);
    },
    getReviewSettings() {
      return { automationMode: "auto_with_fuse" as const, maxReworkRounds: 2, updatedAt: null };
    },
    updateTaskReview(id: string, patch: Partial<NonNullable<Task["review"]>>) {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task not found: ${id}`);
      const updated = { ...current, review: defaultTaskReviewSummary({ ...(current.review ?? {}), ...patch }) };
      tasks.set(id, updated);
      return updated;
    },
    updateTask(id: string, updates: Partial<Task>) {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task not found: ${id}`);
      const updated = { ...current, ...updates };
      tasks.set(id, updated);
      return updated;
    },
    createTask(input: { title?: string; prompt: string; model?: string; agentId?: string | null; category?: Task["category"]; parentTaskId?: string | null; review?: Partial<NonNullable<Task["review"]>> }) {
      const task = makeTask({
        id: `rework-${++reworkCounter}`,
        title: input.title ?? "Rework",
        prompt: input.prompt,
        model: input.model ?? "auto",
        agentId: input.agentId ?? null,
        category: input.category ?? "rework",
        parentTaskId: input.parentTaskId ?? null,
        status: "pending",
        review: defaultTaskReviewSummary(input.review),
      });
      tasks.set(task.id, task);
      return task;
    },
    getReviewActionAuditByIdempotency(idempotencyKey: string) {
      const audit = audits.find((entry) => entry.idempotencyKey === idempotencyKey);
      return audit ?? null;
    },
    createReviewActionAudit(input: { taskId: string; rootTaskId: string; action: string; reason: string | null; actorId: string; idempotencyKey: string; now: number }) {
      const existing = audits.find((entry) => entry.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const audit = { id: `audit-${audits.length + 1}`, ...input, createdAt: input.now };
      audits.push(audit);
      return audit;
    },
    addMessage() {},
  };
  const taskQueue = {
    cancel(id: string) {
      taskStore.updateTask(id, { status: "cancelled", error: "Review chain stopped by user" });
    },
    notifyNewTask() {},
  };
  const taskCtx = { sessionId: "session-1", taskStore, taskQueue };
  const broadcasts: unknown[] = [];
  const deps: ApiSharedDeps = {
    logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ApiSharedDeps["logger"],
    allowedDirs: [],
    workspaceRoot: "/tmp/workspace",
    taskQueueAvailable: true,
    resolveTaskContext() {
      return taskCtx as unknown as ReturnType<ApiSharedDeps["resolveTaskContext"]>;
    },
    promoteQueuedTasksToPending() {},
    broadcastToSession(_sessionId, payload) {
      broadcasts.push(payload);
    },
    buildAttachmentRawUrl() {
      return "";
    },
  };
  return { tasks, audits, deps, broadcasts };
}

async function postReviewAction(harness: ReturnType<typeof createHarness>, taskId: string, body: unknown) {
  const url = new URL(`http://localhost/api/tasks/${taskId}/review-actions?workspace=/tmp/workspace`);
  const res = createRes();
  const ctx: ApiRouteContext = {
    req: createReq(body) as unknown as ApiRouteContext["req"],
    res: res as unknown as ApiRouteContext["res"],
    url,
    pathname: url.pathname,
    auth: { userId: "user-1", username: "andy" },
  };
  await handleTaskRoutes(ctx, harness.deps);
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe("web/api review actions", () => {
  it("force-approves, cancels pending follow-ups, and replays idempotently", async () => {
    const harness = createHarness();
    const first = await postReviewAction(harness, "source-1", { action: "force_approve", idempotencyKey: "action-1" });
    assert.equal(first.status, 200);
    assert.equal(harness.tasks.get("source-1")?.review?.status, "approved");
    assert.equal(harness.tasks.get("review-1")?.status, "cancelled");
    assert.equal(harness.audits.length, 1);

    const replay = await postReviewAction(harness, "source-1", { action: "force_approve", idempotencyKey: "action-1" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(harness.audits.length, 1);
  });

  it("creates manual rework with the original Worker assignment", async () => {
    const harness = createHarness();
    const source = harness.tasks.get("source-1")!;
    harness.tasks.set(source.id, {
      ...source,
      review: defaultTaskReviewSummary({ ...source.review, status: "needs_human_intervention" }),
    });
    const result = await postReviewAction(harness, "source-1", {
      action: "edit_rework",
      feedback: "Fix the race before updating the PR.",
      idempotencyKey: "action-2",
    });
    assert.equal(result.status, 200);
    const rework = harness.tasks.get("rework-1");
    assert.ok(rework);
    assert.equal(rework.model, "worker-model");
    assert.equal(rework.agentId, "worker");
    assert.equal(rework.parentTaskId, "review-1");
    assert.equal(harness.audits.length, 1);
  });
});
