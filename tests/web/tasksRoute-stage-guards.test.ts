import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Task } from "../../server/tasks/types.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../server/web/server/api/types.js";
import { handleTaskRoutes } from "../../server/web/server/api/routes/tasks.js";
import { handleTaskByIdRoute } from "../../server/web/server/api/routes/tasks/taskById.js";

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

describe("web/api stage guards", () => {
  it("returns 409 for reorder when any task is not pending", async () => {
    const req = createReq("POST", { ids: ["t-1"] });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/reorder?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      taskStore: {
        reorderPendingTasks() {
          throw new Error("task is not pending: t-1");
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
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parseJson(res.body), { error: "task is not pending: t-1" });
  });

  it("returns 409 for retry when status is not failed", async () => {
    let retryCalls = 0;
    const req = createReq("POST");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/retry?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      taskQueue: {
        retry() {
          retryCalls += 1;
        },
      },
      taskStore: {
        getTask() {
          return { id: "t-1", status: "pending" } as Task;
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
    assert.deepEqual(parseJson(res.body), { error: "Task not retryable in status: pending" });
    assert.equal(retryCalls, 0);
  });

  it("returns 409 for cancel action when task is not active", async () => {
    const req = createReq("PATCH", { action: "cancel" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      runController: { setModeAll() {}, setModeManual() {} },
      taskQueue: { pause() {}, resume() {}, cancel() {} },
      taskStore: {
        getTask() {
          return { id: "t-1", status: "pending" } as Task;
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

    const handled = await handleTaskByIdRoute(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parseJson(res.body), { error: "Task not cancellable in status: pending" });
  });

  it("pauses an all-mode queue before cancelling its active task", async () => {
    const calls: string[] = [];
    const task = { id: "t-1", title: "Task", status: "running" } as Task;
    const req = createReq("PATCH", { action: "cancel" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: true,
      runController: {
        getMode() {
          return "all";
        },
        setModeManual() {
          calls.push("setModeManual");
        },
      },
      taskQueue: {
        pause(reason: string) {
          calls.push(`pause:${reason}`);
        },
        cancel() {
          calls.push("cancel");
          task.status = "cancelled";
        },
      },
      taskStore: {
        getTask() {
          return task;
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

    const handled = await handleTaskByIdRoute(
      { req: req as any, res: res as any, url, pathname: url.pathname, auth: { userId: "u", username: "u" } },
      deps,
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ["setModeManual", "pause:cancel", "cancel"]);
    assert.equal(taskCtx.queueRunning, false);
    assert.equal(task.status, "cancelled");
  });

  it("resume action promotes queued tasks before resuming the queue", async () => {
    let promoteCalls = 0;
    let resumeCalls = 0;
    let setModeAllCalls = 0;
    let maybePauseCalls = 0;

    const req = createReq("PATCH", { action: "resume" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1?workspace=/tmp/ws");

    const taskCtx = {
      sessionId: "s-1",
      queueRunning: false,
      runController: {
        setModeAll() {
          setModeAllCalls += 1;
        },
        setModeManual() {},
        maybePauseAfterDrain() {
          maybePauseCalls += 1;
          return false;
        },
      },
      taskQueue: {
        pause() {},
        resume() {
          resumeCalls += 1;
        },
        cancel() {},
      },
      taskStore: {
        getTask() {
          return { id: "t-1", status: "queued" } as Task;
        },
        listTasks() {
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

    const handled = await handleTaskByIdRoute(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson(res.body), { success: true });
    assert.equal(setModeAllCalls, 1);
    assert.equal(resumeCalls, 1);
    assert.equal(promoteCalls, 1);
    assert.equal(maybePauseCalls, 1);
  });
});
