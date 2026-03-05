import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Task } from "../../server/tasks/types.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../server/web/server/api/types.js";
import { handleTaskRoutes } from "../../server/web/server/api/routes/tasks.js";

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
  end: (body: string) => void;
};

function createReq(method: string, body?: unknown): FakeReq {
  const payload = body == null ? "" : JSON.stringify(body);
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (!payload) return;
      yield Buffer.from(payload, "utf8");
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
    end(body: string) {
      this.body = body;
    },
  };
}

function parseJson(body: string): unknown {
  return body ? (JSON.parse(body) as unknown) : null;
}

describe("web/api review mark done", () => {
  it("returns 409 when task does not have review enabled", async () => {
    const req = createReq("POST");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/review/mark-done?workspace=/tmp/ws");

    const existing = { id: "t-1", status: "completed", reviewRequired: false } as Task;
    const taskCtx = {
      sessionId: "s-1",
      taskStore: {
        getTask() {
          return existing;
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as any;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parseJson(res.body), { error: "Task review is not enabled" });
  });

  it("returns 409 when task is not completed", async () => {
    const req = createReq("POST");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/review/mark-done?workspace=/tmp/ws");

    const existing = { id: "t-1", status: "running", reviewRequired: true } as Task;
    const taskCtx = {
      sessionId: "s-1",
      taskStore: {
        getTask() {
          return existing;
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as any;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parseJson(res.body), { error: "Task not markable as done in status: running" });
  });

  it("sets reviewStatus=passed and preserves existing conclusion/reviewedAt", async () => {
    const req = createReq("POST");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/review/mark-done?workspace=/tmp/ws");

    const existing = {
      id: "t-1",
      status: "completed",
      reviewRequired: true,
      reviewStatus: "rejected",
      reviewConclusion: "needs fixes",
      reviewedAt: 1700000000000,
    } as Task;

    let lastUpdate: { id?: string; updates?: Record<string, unknown>; now?: number } = {};
    const updatedTask = {
      ...existing,
      reviewStatus: "passed",
    } as Task;

    const taskCtx = {
      sessionId: "s-1",
      taskStore: {
        getTask() {
          return existing;
        },
        updateTask(id: string, updates: Record<string, unknown>, now: number) {
          lastUpdate = { id, updates, now };
          return { ...updatedTask, ...(updates as any) };
        },
      },
    };

    let broadcasts = 0;
    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as any;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {
        broadcasts += 1;
      },
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = parseJson(res.body) as any;
    assert.equal(payload?.success, true);
    assert.equal(payload?.task?.reviewStatus, "passed");
    assert.equal(payload?.task?.reviewConclusion, "needs fixes");
    assert.equal(payload?.task?.reviewedAt, 1700000000000);

    assert.equal(lastUpdate.id, "t-1");
    assert.equal(lastUpdate.updates?.reviewStatus, "passed");
    assert.equal(lastUpdate.updates?.reviewConclusion, "needs fixes");
    assert.equal(lastUpdate.updates?.reviewedAt, 1700000000000);
    assert.equal(typeof lastUpdate.now, "number");
    assert.equal(broadcasts, 1);
  });

  it("fills default reviewConclusion when empty", async () => {
    const req = createReq("POST");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/review/mark-done?workspace=/tmp/ws");

    const existing = {
      id: "t-1",
      status: "completed",
      reviewRequired: true,
      reviewStatus: "pending",
      reviewConclusion: null,
      reviewedAt: null,
    } as Task;

    let capturedUpdates: Record<string, unknown> | null = null;
    const taskCtx = {
      sessionId: "s-1",
      taskStore: {
        getTask() {
          return existing;
        },
        updateTask(_id: string, updates: Record<string, unknown>) {
          capturedUpdates = updates;
          return { ...existing, ...(updates as any) };
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as any;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = parseJson(res.body) as any;
    assert.equal(payload?.task?.reviewConclusion, "manually marked as done");
    assert.equal(capturedUpdates?.reviewConclusion, "manually marked as done");
  });
});

