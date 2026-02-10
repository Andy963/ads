import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Task } from "../../src/tasks/types.js";
import { resetStateDatabaseForTests } from "../../src/state/database.js";
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
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
    once() {
      // ignore for tests
    },
  };
}

describe("web/api/tasks/:id/rerun", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-tasks-rerun-bootstrap-test-"));
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

  it("copies source modelParams when rerunning with empty payload", async () => {
    const now = Date.now();
    const source: Task = {
      id: "t-1",
      title: "T",
      prompt: "P",
      model: "auto",
      modelParams: { foo: "bar", bootstrap: { enabled: true, projectRef: "/tmp/project", maxIterations: 7 } },
      status: "completed",
      priority: 0,
      queueOrder: 0,
      inheritContext: true,
      agentId: null,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
    };

    let createInput: Record<string, unknown> | null = null;

    const taskCtx = {
      sessionId: "s-1",
      workspaceRoot: "/tmp/ws",
      metrics: { counts: {}, events: [] },
      taskStore: {
        getTask(id: string) {
          return id === source.id ? source : null;
        },
        createTask(input: Record<string, unknown>) {
          createInput = input;
          return {
            id: String(input.id),
            title: String(input.title),
            prompt: String(input.prompt),
            model: String(input.model),
            modelParams: (input.modelParams as any) ?? null,
            status: "queued",
            priority: 0,
            queueOrder: 0,
            inheritContext: Boolean(input.inheritContext),
            agentId: null,
            retryCount: 0,
            maxRetries: 3,
            createdAt: Date.now(),
            parentTaskId: String(input.parentTaskId ?? ""),
          } satisfies Task;
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

    const req = createReq("POST", {});
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/rerun?workspace=/tmp/ws");

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 201);

    assert.ok(createInput);
    assert.deepEqual(createInput?.modelParams, source.modelParams);
  });

  it("clears bootstrap modelParams when rerunning with bootstrap=null", async () => {
    const now = Date.now();
    const source: Task = {
      id: "t-1",
      title: "T",
      prompt: "P",
      model: "auto",
      modelParams: { foo: "bar", bootstrap: { enabled: true, projectRef: "/tmp/project", maxIterations: 7 } },
      status: "completed",
      priority: 0,
      queueOrder: 0,
      inheritContext: true,
      agentId: null,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
    };

    let createInput: Record<string, unknown> | null = null;

    const taskCtx = {
      sessionId: "s-1",
      workspaceRoot: "/tmp/ws",
      metrics: { counts: {}, events: [] },
      taskStore: {
        getTask(id: string) {
          return id === source.id ? source : null;
        },
        createTask(input: Record<string, unknown>) {
          createInput = input;
          return {
            id: String(input.id),
            title: String(input.title),
            prompt: String(input.prompt),
            model: String(input.model),
            modelParams: (input.modelParams as any) ?? null,
            status: "queued",
            priority: 0,
            queueOrder: 0,
            inheritContext: Boolean(input.inheritContext),
            agentId: null,
            retryCount: 0,
            maxRetries: 3,
            createdAt: Date.now(),
            parentTaskId: String(input.parentTaskId ?? ""),
          } satisfies Task;
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

    const req = createReq("POST", { bootstrap: null });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/t-1/rerun?workspace=/tmp/ws");

    const ctx: ApiRouteContext = {
      req: req as unknown as ApiRouteContext["req"],
      res: res as unknown as ApiRouteContext["res"],
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(ctx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 201);

    assert.ok(createInput);
    assert.deepEqual(createInput?.modelParams, { foo: "bar" });
  });
});

