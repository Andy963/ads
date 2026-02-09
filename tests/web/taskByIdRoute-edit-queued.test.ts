import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Task } from "../../src/tasks/types.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../src/web/server/api/types.js";
import { handleTaskByIdRoute } from "../../src/web/server/api/routes/tasks/taskById.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
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

describe("web/api/tasks/:id PATCH", () => {
  it("allows editing queued tasks", async () => {
    let task: Task = {
      id: "t-queued",
      title: "T",
      prompt: "P",
      model: "auto",
      status: "queued",
      priority: 0,
      queueOrder: 0,
      queuedAt: Date.now(),
      inheritContext: true,
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
    };

    const req = createReq("PATCH", { title: "Updated title" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-queued");

    const taskCtx = {
      sessionId: "s",
      queueRunning: false,
      taskStore: {
        getTask(id: string) {
          return id === task.id ? task : null;
        },
        updateTask(id: string, updates: Record<string, unknown>) {
          assert.equal(id, task.id);
          task = { ...task, ...(updates as Partial<Task>) };
          return task;
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ApiSharedDeps["logger"],
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as unknown as ReturnType<ApiSharedDeps["resolveTaskContext"]>;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskByIdRoute(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);

    const payload = parseJson(res.body) as Record<string, unknown>;
    assert.equal(payload.success, true);
    assert.equal((payload.task as Task).title, "Updated title");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req: FakeReq = {
      method: "PATCH",
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{", "utf8");
      },
    };
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-queued");

    const taskCtx = {
      sessionId: "s",
      queueRunning: false,
      taskStore: {
        getTask() {
          return null;
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ApiSharedDeps["logger"],
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as unknown as ReturnType<ApiSharedDeps["resolveTaskContext"]>;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskByIdRoute(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson(res.body), { error: "Invalid JSON body" });
  });

  it("returns 400 for invalid action payload", async () => {
    const req = createReq("PATCH", { action: "nope" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-queued");

    const taskCtx = {
      sessionId: "s",
      queueRunning: false,
      taskStore: {
        getTask() {
          return null;
        },
      },
      taskQueue: {
        pause() {},
        resume() {},
        cancel() {},
      },
      runController: {
        setModeManual() {},
        setModeAll() {},
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ApiSharedDeps["logger"],
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext() {
        return taskCtx as unknown as ReturnType<ApiSharedDeps["resolveTaskContext"]>;
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskByIdRoute(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson(res.body), { error: "Invalid payload" });
  });
});
