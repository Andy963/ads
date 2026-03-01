import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TaskQueueContext, TaskQueueMetrics } from "../../server/web/server/taskQueue/manager.js";
import { handleTaskQueueRoutes } from "../../server/web/server/api/routes/taskQueue.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
};

type MutableRuntimeState = {
  setModeAllCalls: number;
  setModeManualCalls: number;
  maybePauseCalls: number;
  resumeCalls: number;
  pauseCalls: number;
};

function createReq(method: string, body?: unknown): FakeReq {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: payload ? { "content-type": "application/json" } : {},
    async *[Symbol.asyncIterator]() {
      if (payload) {
        yield payload;
      }
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body?: string) {
      this.body = typeof body === "string" ? body : "";
    },
  };
}

function parseJson<T>(res: FakeRes): T {
  return JSON.parse(res.body) as T;
}

function createMetrics(): TaskQueueMetrics {
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

function createTaskContext(args?: {
  busy?: boolean;
  queueRunning?: boolean;
  status?: Record<string, unknown>;
}): { taskCtx: TaskQueueContext; state: MutableRuntimeState } {
  const state: MutableRuntimeState = {
    setModeAllCalls: 0,
    setModeManualCalls: 0,
    maybePauseCalls: 0,
    resumeCalls: 0,
    pauseCalls: 0,
  };

  const busy = Boolean(args?.busy);
  const queueRunning = Boolean(args?.queueRunning);
  const status = args?.status ?? { mode: "all", activeTaskId: null };

  const taskCtx = {
    workspaceRoot: "/tmp/ws",
    sessionId: "default",
    lock: {
      isBusy: () => busy,
      runExclusive: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    },
    taskStore: {} as any,
    attachmentStore: {} as any,
    taskQueue: {
      resume: () => {
        state.resumeCalls += 1;
      },
      pause: (_reason: string) => {
        state.pauseCalls += 1;
      },
    } as any,
    queueAutoStart: false,
    queueRunning,
    dequeueInProgress: false,
    metrics: createMetrics(),
    runController: {
      setModeAll: () => {
        state.setModeAllCalls += 1;
      },
      setModeManual: () => {
        state.setModeManualCalls += 1;
      },
      maybePauseAfterDrain: () => {
        state.maybePauseCalls += 1;
      },
    } as any,
    getStatusOrchestrator: () => ({
      status: () => status,
    }),
    getTaskQueueOrchestrator: () => ({
      status: () => status,
    }),
  } as TaskQueueContext;

  return { taskCtx, state };
}

describe("web/api/routes/taskQueue", () => {
  it("returns false for unmatched path", async () => {
    const { taskCtx } = createTaskContext();
    const req = createReq("GET");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/unknown"),
        pathname: "/api/unknown",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );
    assert.equal(ok, false);
  });

  it("returns queue status payload", async () => {
    const { taskCtx } = createTaskContext({ queueRunning: true, status: { mode: "manual", paused: false } });
    const req = createReq("GET");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/status"),
        pathname: "/api/task-queue/status",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson<Record<string, unknown>>(res), {
      enabled: true,
      running: true,
      mode: "manual",
      paused: false,
    });
  });

  it("returns queue metrics payload", async () => {
    const { taskCtx } = createTaskContext({ queueRunning: true });
    taskCtx.metrics.counts.TASK_ADDED = 2;

    const req = createReq("GET");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/metrics"),
        pathname: "/api/task-queue/metrics",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 200);
    const payload = parseJson<Record<string, unknown>>(res);
    assert.equal(payload.workspaceRoot, "/tmp/ws");
    assert.equal(payload.running, true);
    assert.deepEqual(payload.counts, taskCtx.metrics.counts);
  });

  it("returns 202 queued for busy run requests", async () => {
    const { taskCtx, state } = createTaskContext({ busy: true, queueRunning: false });
    let promoted = 0;

    const req = createReq("POST");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/run"),
        pathname: "/api/task-queue/run",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {
          promoted += 1;
        },
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(parseJson<Record<string, unknown>>(res), {
      success: true,
      queued: true,
      enabled: true,
      running: true,
      mode: "all",
      activeTaskId: null,
    });
    assert.equal(state.setModeAllCalls, 1);
    assert.equal(state.resumeCalls, 1);
    assert.equal(state.maybePauseCalls, 1);
    assert.equal(promoted, 1);
    assert.equal(taskCtx.queueRunning, true);
  });

  it("returns 200 for run when lock is idle", async () => {
    const { taskCtx, state } = createTaskContext({ busy: false, queueRunning: false });

    const req = createReq("POST");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/run"),
        pathname: "/api/task-queue/run",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson<Record<string, unknown>>(res), {
      success: true,
      queued: false,
      enabled: true,
      running: true,
      mode: "all",
      activeTaskId: null,
    });
    assert.equal(state.setModeAllCalls, 1);
    assert.equal(state.resumeCalls, 1);
  });

  it("returns 200 for pause and sets manual mode", async () => {
    const { taskCtx, state } = createTaskContext({ queueRunning: true, status: { mode: "manual", paused: true } });

    const req = createReq("POST");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/pause"),
        pathname: "/api/task-queue/pause",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson<Record<string, unknown>>(res), {
      success: true,
      enabled: true,
      running: false,
      mode: "manual",
      paused: true,
    });
    assert.equal(state.setModeManualCalls, 1);
    assert.equal(state.pauseCalls, 1);
    assert.equal(taskCtx.queueRunning, false);
  });

  it("returns 409 when queue is disabled", async () => {
    const { taskCtx } = createTaskContext();

    const req = createReq("POST");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/run"),
        pathname: "/api/task-queue/run",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: false,
        resolveTaskContext: () => taskCtx,
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parseJson<{ error: string }>(res), { error: "Task queue disabled" });
  });

  it("returns 400 when task context resolution fails", async () => {
    const req = createReq("GET");
    const res = createRes();
    const ok = await handleTaskQueueRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/task-queue/status"),
        pathname: "/api/task-queue/status",
        auth: { userId: "u", username: "u" },
      },
      {
        taskQueueAvailable: true,
        resolveTaskContext: () => {
          throw new Error("bad workspace");
        },
        promoteQueuedTasksToPending: () => {},
      },
    );

    assert.equal(ok, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson<{ error: string }>(res), { error: "bad workspace" });
  });
});
