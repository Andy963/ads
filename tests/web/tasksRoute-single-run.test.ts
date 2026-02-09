import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleTaskRoutes } from "../../src/web/server/api/routes/tasks.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../src/web/server/api/types.js";

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

function createReq(method: string): FakeReq {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      // No body.
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

describe("web/api/tasks/:id/run", () => {
  it("handles background runExclusive rejections without throwing", async () => {
    const taskId = "t-1";
    const warned: string[] = [];

    const taskCtx = {
      sessionId: "s-1",
      lock: {
        isBusy() {
          return true;
        },
        runExclusive() {
          return Promise.reject(new Error("boom"));
        },
      },
      taskStore: {
        getTask(id: string) {
          return id === taskId ? { id: taskId } : null;
        },
      },
    };

    const deps: ApiSharedDeps = {
      logger: {
        info() {},
        warn(msg: string) {
          warned.push(msg);
        },
        debug() {},
        error() {},
      } as unknown as ApiSharedDeps["logger"],
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

    const req = createReq("POST");
    const res = createRes();
    const url = new URL(`http://localhost/api/tasks/${taskId}/run?workspace=/tmp/ws`);

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 202);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.includes("background single-task run failed"));
  });
});

