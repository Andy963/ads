import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleTaskRoutes } from "../../server/web/server/api/routes/tasks.js";
import type { ApiRouteContext, ApiSharedDeps } from "../../server/web/server/api/types.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { createAbortError } from "../../server/utils/abort.js";
import type { AgentEvent } from "../../server/codex/events.js";

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
    once() {},
  };
}

describe("web/api/tasks/:id/chat route", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-task-chat-test-"));
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

  it("broadcasts step traces and chat deltas, then unsubscribes on complete", async () => {
    const req = createReq("POST", { content: "Please run tests" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/task-123/chat?workspace=/tmp/ws");

    let eventHandler: ((ev: AgentEvent) => void) | null = null;
    let unsubscribed = false;

    const orchestrator = {
      setModel() {},
      onEvent(handler: (ev: AgentEvent) => void) {
        eventHandler = handler;
        return () => {
          unsubscribed = true;
          eventHandler = null;
        };
      },
      async invokeAgent() {
        assert.ok(eventHandler);
        // 1. step trace (tool)
        eventHandler!({
          phase: "tool",
          title: "Calling tool",
          detail: "exec.bash",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "tool_call" } } as any,
        });
        // 2. step trace (editing)
        eventHandler!({
          phase: "editing",
          title: "File edit",
          detail: "mod.ts",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "file_change", changes: [] } } as any,
        });
        // 3. command
        eventHandler!({
          phase: "command",
          title: "执行命令",
          detail: "ls -la",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "command_execution", command: "ls -la" } } as any,
        });
        // 4. streaming responding
        eventHandler!({
          phase: "responding",
          title: "Responding",
          delta: "Done ",
          timestamp: Date.now(),
          raw: { type: "item.updated", item: { type: "agent_message", text: "Done " } } as any,
        });
        eventHandler!({
          phase: "responding",
          title: "Responding",
          delta: "Done all",
          timestamp: Date.now(),
          raw: { type: "item.updated", item: { type: "agent_message", text: "Done all" } } as any,
        });

        return { response: "Done all" };
      },
    };

    const task = {
      id: "task-123",
      title: "Task 123",
      prompt: "Original prompt",
      model: "auto",
      status: "running",
      agentId: "codex",
    };

    const broadcasted: Array<any> = [];
    const lock = new AsyncLock();

    const taskCtx = {
      sessionId: "s-1",
      getLock: () => lock,
      getTaskQueueOrchestrator: () => orchestrator,
      taskStore: {
        getTask: (id: string) => (id === "task-123" ? task : null),
        addMessage() {},
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
      broadcastToSession(sessionId, payload) {
        broadcasted.push({ sessionId, payload });
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

    // Wait for the async lock task to finish
    await lock.runExclusive(async () => {});

    assert.equal(unsubscribed, true);

    const stepDeltas = broadcasted.filter(
      (b) => b.payload.event === "message:delta" && b.payload.data?.source === "step",
    );
    assert.deepEqual(
      stepDeltas.map((s) => s.payload.data.delta),
      ["[tool] Calling tool: exec.bash\n", "[editing] File edit: mod.ts\n"],
    );

    const chatDeltas = broadcasted.filter(
      (b) => b.payload.event === "message:delta" && b.payload.data?.source === "chat",
    );
    assert.deepEqual(
      chatDeltas.map((s) => s.payload.data.delta),
      ["Done ", "all"],
    );

    const commands = broadcasted.filter((b) => b.payload.event === "command");
    assert.deepEqual(
      commands.map((c) => c.payload.data.command),
      ["ls -la"],
    );
  });

  it("unsubscribes on error during chat execution", async () => {
    const req = createReq("POST", { content: "Fail please" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/task-123/chat?workspace=/tmp/ws");

    let unsubscribed = false;
    const orchestrator = {
      setModel() {},
      onEvent() {
        return () => {
          unsubscribed = true;
        };
      },
      async invokeAgent() {
        throw new Error("mock chat failure");
      },
    };

    const task = {
      id: "task-123",
      title: "Task 123",
      prompt: "Prompt",
      status: "running",
      agentId: "codex",
    };

    const lock = new AsyncLock();
    const broadcasted: Array<any> = [];

    const taskCtx = {
      sessionId: "s-1",
      getLock: () => lock,
      getTaskQueueOrchestrator: () => orchestrator,
      taskStore: {
        getTask: (id: string) => (id === "task-123" ? task : null),
        addMessage() {},
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext: () => taskCtx as any,
      promoteQueuedTasksToPending() {},
      broadcastToSession: (sessionId, payload) => {
        broadcasted.push({ sessionId, payload });
      },
      buildAttachmentRawUrl: () => "",
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

    // Wait for the async lock task to finish
    await lock.runExclusive(async () => {});

    assert.equal(unsubscribed, true);
    const failures = broadcasted.filter(
      (b) => b.payload.event === "message" && b.payload.data?.content?.includes("[Chat failed]"),
    );
    assert.equal(failures.length, 1);
  });

  it("unsubscribes when chat execution is cancelled", async () => {
    const req = createReq("POST", { content: "Cancel please" });
    const res = createRes();
    const url = new URL("http://localhost/api/tasks/task-123/chat?workspace=/tmp/ws");

    let unsubscribed = false;
    const orchestrator = {
      setModel() {},
      onEvent() {
        return () => {
          unsubscribed = true;
        };
      },
      async invokeAgent() {
        throw createAbortError("cancelled");
      },
    };

    const task = {
      id: "task-123",
      title: "Task 123",
      prompt: "Prompt",
      status: "running",
      agentId: "codex",
    };

    const lock = new AsyncLock();
    const broadcasted: Array<any> = [];
    const taskCtx = {
      sessionId: "s-1",
      getLock: () => lock,
      getTaskQueueOrchestrator: () => orchestrator,
      taskStore: {
        getTask: (id: string) => (id === "task-123" ? task : null),
        addMessage() {},
      },
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext: () => taskCtx as any,
      promoteQueuedTasksToPending() {},
      broadcastToSession: (sessionId, payload) => {
        broadcasted.push({ sessionId, payload });
      },
      buildAttachmentRawUrl: () => "",
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

    await lock.runExclusive(async () => {});

    assert.equal(unsubscribed, true);
    const failures = broadcasted.filter(
      (b) => b.payload.event === "message" && b.payload.data?.content?.includes("[Chat failed]"),
    );
    assert.equal(failures.length, 1);
  });
});
