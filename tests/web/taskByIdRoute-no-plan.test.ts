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

function parseJson(body: string): unknown {
  return body ? (JSON.parse(body) as unknown) : null;
}

describe("web/api/tasks/:id", () => {
  it("does not include a plan payload in GET /api/tasks/:id", async () => {
    const task: Task = {
      id: "t-1",
      title: "T",
      prompt: "P",
      model: "auto",
      status: "pending",
      priority: 0,
      queueOrder: 0,
      inheritContext: true,
      retryCount: 0,
      maxRetries: 0,
      createdAt: Date.now(),
    };

    const req = createReq("GET");
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1");

    const taskCtx = {
      taskStore: {
        getTask(id: string) {
          return id === task.id ? task : null;
        },
        getMessages() {
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
    assert.equal(payload.id, "t-1");
    assert.ok(Array.isArray(payload.messages), "messages should be present");
    assert.ok(!("plan" in payload), "plan should not be present");
  });
});

