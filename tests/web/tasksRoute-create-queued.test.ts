import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleTaskRoutes } from "../../server/web/server/api/routes/tasks.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../server/web/server/api/types.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";

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
  once: (event: string, cb: () => void) => void;
};

function createReq(method: string, body: unknown): FakeReq {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield payload;
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
    once() {
      // The route registers async maintenance handlers on res.finish; ignore for tests.
    },
  };
}

describe("web/api/tasks create", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-tasks-route-test-"));
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
  });

  it("creates tasks as queued and promotes them when the queue is already running (all mode)", async () => {
    const req = createReq("POST", { prompt: "Hello" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks?workspace=/tmp/ws");

    let createStatus: unknown = null;
    let promoteCalls = 0;

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: true,
      metrics: { counts: {}, events: [] },
      runController: {
        getMode() {
          return "all";
        },
      },
      taskQueue: {
        notifyNewTask() {},
      },
      taskStore: {
        createTask(_input: unknown, _now: number, options?: unknown) {
          createStatus = (options as { status?: unknown } | undefined)?.status ?? null;
          return { id: "t-1", title: "T", prompt: "Hello", model: "auto", status: "queued", priority: 0, queueOrder: 0, inheritContext: false, retryCount: 0, maxRetries: 0, createdAt: Date.now() } as any;
        },
        deleteTask() {},
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
        },
        assignAttachmentsToTask() {},
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
      promoteQueuedTasksToPending() {
        promoteCalls += 1;
      },
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
    assert.equal(res.statusCode, 201);
    assert.equal(createStatus, "queued");
    assert.equal(promoteCalls, 1);
  });

  it("does not auto-promote when the queue is running in single-task mode", async () => {
    const req = createReq("POST", { prompt: "Hello" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks?workspace=/tmp/ws");

    let promoteCalls = 0;

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: true,
      metrics: { counts: {}, events: [] },
      runController: {
        getMode() {
          return "single";
        },
      },
      taskQueue: {
        notifyNewTask() {},
      },
      taskStore: {
        createTask() {
          return { id: "t-1", title: "T", prompt: "Hello", model: "auto", status: "queued", priority: 0, queueOrder: 0, inheritContext: false, retryCount: 0, maxRetries: 0, createdAt: Date.now() } as any;
        },
        deleteTask() {},
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
        },
        assignAttachmentsToTask() {},
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
      promoteQueuedTasksToPending() {
        promoteCalls += 1;
      },
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
    assert.equal(res.statusCode, 201);
    assert.equal(promoteCalls, 0);
  });

  it("ignores legacy inheritContext field in create payload", async () => {
    const req = createReq("POST", { prompt: "Hello", inheritContext: true });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks?workspace=/tmp/ws");

    let createInput: Record<string, unknown> | null = null;

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      metrics: { counts: {}, events: [] },
      runController: {
        getMode() {
          return "manual";
        },
      },
      taskQueue: {
        notifyNewTask() {},
      },
      taskStore: {
        createTask(input: Record<string, unknown>) {
          createInput = input;
          return { id: "t-1", title: "T", prompt: "Hello", model: "auto", status: "queued", priority: 0, queueOrder: 0, inheritContext: false, retryCount: 0, maxRetries: 0, createdAt: Date.now() } as any;
        },
        deleteTask() {},
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
        },
        assignAttachmentsToTask() {},
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
    assert.equal(res.statusCode, 201);
    assert.ok(createInput);
    assert.equal(Object.prototype.hasOwnProperty.call(createInput, "inheritContext"), false);
  });

  it("returns 400 for invalid JSON body", async () => {
    let createCalls = 0;
    const req: FakeReq = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{", "utf8");
      },
    };
    const res = createRes();
    const url = new URL("http://localhost/api/tasks?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: true,
      metrics: { counts: {}, events: [] },
      taskQueue: {
        notifyNewTask() {},
      },
      taskStore: {
        createTask() {
          createCalls += 1;
          return { id: "t-1" } as any;
        },
        deleteTask() {},
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
        },
        assignAttachmentsToTask() {},
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
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "Invalid JSON body" });
    assert.equal(createCalls, 0);
  });

  it("returns 400 for invalid create payload", async () => {
    let createCalls = 0;
    const req = createReq("POST", { prompt: 123 });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: true,
      metrics: { counts: {}, events: [] },
      taskQueue: {
        notifyNewTask() {},
      },
      taskStore: {
        createTask() {
          createCalls += 1;
          return { id: "t-1" } as any;
        },
        deleteTask() {},
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
        },
        assignAttachmentsToTask() {},
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
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "Invalid payload" });
    assert.equal(createCalls, 0);
  });

  it("returns 400 for invalid reorder payload", async () => {
    let reorderCalls = 0;
    const req = createReq("POST", { ids: [] });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/reorder?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      taskStore: {
        reorderPendingTasks() {
          reorderCalls += 1;
          return [];
        },
      },
      attachmentStore: {
        listAttachmentsForTask() {
          return [];
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
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "Invalid payload" });
    assert.equal(reorderCalls, 0);
  });
});
