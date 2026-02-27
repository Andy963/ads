import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import type { TaskQueueMetrics } from "../../src/web/server/taskQueue/manager.js";
import { handleTaskBundleDraftRoutes } from "../../src/web/server/api/routes/taskBundleDrafts.js";
import { approveTaskBundleDraft, upsertTaskBundleDraft } from "../../src/web/server/planner/taskBundleDraftStore.js";

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
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) {
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
    end(body: string) {
      this.body = body;
    },
  };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
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

function ensureSpecFiles(workspaceRoot: string, slug: string): string {
  const specRef = `docs/spec/${slug}`;
  const specDir = path.resolve(workspaceRoot, specRef);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "requirements.md"), "# Requirements\n", "utf8");
  fs.writeFileSync(path.join(specDir, "design.md"), "# Design\n", "utf8");
  fs.writeFileSync(path.join(specDir, "implementation.md"), "# Implementation\n", "utf8");
  return specRef;
}

describe("web/api/task-bundle-drafts", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-bundle-drafts-"));
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

  it("lists, updates, deletes drafts in a workspace scope", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-1";

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r1", tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async (fn: () => Promise<void>) => fn() },
          taskStore: {} as any,
          attachmentStore: {} as any,
          taskQueue: {} as any,
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: {} as any,
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const listReq = createReq("GET");
    const listRes = createRes();
    const listUrl = new URL(`http://localhost/api/task-bundle-drafts?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: listReq as any, res: listRes as any, url: listUrl, pathname: "/api/task-bundle-drafts", auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(listRes.statusCode, 200);
    const listed = parseJson<{ drafts: Array<{ id: string; status: string; bundle: unknown }> }>(listRes.body).drafts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, inserted.id);

    const patchReq = createReq("PATCH", { bundle: { version: 1, requestId: "r1", tasks: [{ prompt: "p2" }, { prompt: "p3" }] } });
    const patchRes = createRes();
    const patchUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: patchReq as any, res: patchRes as any, url: patchUrl, pathname: `/api/task-bundle-drafts/${inserted.id}`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(patchRes.statusCode, 200);
    const patched = parseJson<{ draft: { id: string; bundle: { tasks: Array<{ prompt: string }> } } }>(patchRes.body).draft;
    assert.equal(patched.id, inserted.id);
    assert.deepEqual(patched.bundle.tasks.map((t) => t.prompt), ["p2", "p3"]);

    const delReq = createReq("DELETE");
    const delRes = createRes();
    const delUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: delReq as any, res: delRes as any, url: delUrl, pathname: `/api/task-bundle-drafts/${inserted.id}`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(delRes.statusCode, 200);
    assert.deepEqual(parseJson<{ success: boolean }>(delRes.body), { success: true });

    const listAfterReq = createReq("GET");
    const listAfterRes = createRes();
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: listAfterReq as any, res: listAfterRes as any, url: listUrl, pathname: "/api/task-bundle-drafts", auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(listAfterRes.statusCode, 200);
    assert.deepEqual(parseJson<{ drafts: unknown[] }>(listAfterRes.body).drafts, []);
  });

  it("returns 400 for invalid JSON body", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-invalid-json";

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async (fn: () => Promise<void>) => fn() },
          taskStore: {} as any,
          attachmentStore: {} as any,
          taskQueue: {} as any,
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: {} as any,
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const req: FakeReq = {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{", "utf8");
      },
    };
    const res = createRes();
    const url = new URL(`http://localhost/api/task-bundle-drafts/d-1?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: req as any, res: res as any, url, pathname: "/api/task-bundle-drafts/d-1", auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson<{ error: string }>(res.body), { error: "Invalid JSON body" });
  });

  it("rejects approval when draft bundle has no specRef", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-no-spec-ref";

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r-no-spec", tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async (fn: () => Promise<void>) => fn() },
          taskStore: {} as any,
          attachmentStore: {} as any,
          taskQueue: {} as any,
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: {} as any,
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const approveReq = createReq("POST", { runQueue: false });
    const approveRes = createRes();
    const approveUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}/approve?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveReq as any, res: approveRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRes.statusCode, 400);
    const payload = parseJson<{ error: string }>(approveRes.body);
    assert.equal(payload.error, "specRef is required before approving draft");
  });

  it("rejects approval when spec files are incomplete", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-missing-spec-files";
    const specRef = "docs/spec/incomplete";
    const specDir = path.resolve(workspaceRoot, specRef);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "requirements.md"), "# Requirements\n", "utf8");

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r-missing-files", specRef, tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async (fn: () => Promise<void>) => fn() },
          taskStore: {} as any,
          attachmentStore: {} as any,
          taskQueue: {} as any,
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: {} as any,
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const approveReq = createReq("POST", { runQueue: false });
    const approveRes = createRes();
    const approveUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}/approve?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveReq as any, res: approveRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRes.statusCode, 400);
    const payload = parseJson<{ error: string }>(approveRes.body);
    assert.match(payload.error, /Spec files missing/);
  });

  it("approves drafts idempotently and can run the queue", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-2";
    const specRef = ensureSpecFiles(workspaceRoot, "approve-idempotent");

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: {
        version: 1,
        requestId: "r2",
        specRef,
        tasks: [
          { externalId: "a", prompt: "p1", attachments: ["att-1"] },
          { externalId: "b", prompt: "p2" },
        ],
      },
      now: 10,
    });

    const tasksById = new Map<string, any>();
    const attachmentsByTaskId = new Map<string, string[]>();
    let resumeCalled = 0;
    let setModeCalled = 0;
    let promoteCalled = 0;
    const broadcasted: Array<{ sessionId: string; payload: unknown }> = [];

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async (fn: () => Promise<void>) => fn() },
          taskStore: {
            createTask(input: { id: string; prompt: string; title?: string }, now: number, opts: { status: string }) {
              if (tasksById.has(input.id)) {
                throw new Error("duplicate");
              }
              const task = {
                id: input.id,
                title: input.title ?? "",
                prompt: input.prompt,
                model: "auto",
                status: opts.status,
                priority: 0,
                queueOrder: 0,
                inheritContext: true,
                retryCount: 0,
                maxRetries: 0,
                createdAt: now,
              };
              tasksById.set(task.id, task);
              return task;
            },
            getTask(id: string) {
              return tasksById.get(id) ?? null;
            },
            deleteTask(id: string) {
              tasksById.delete(id);
            },
          },
          attachmentStore: {
            assignAttachmentsToTask(taskId: string, ids: string[]) {
              attachmentsByTaskId.set(taskId, ids.slice());
            },
            listAttachmentsForTask(taskId: string) {
              const ids = attachmentsByTaskId.get(taskId) ?? [];
              return ids.map((id) => ({
                id,
                url: "",
                sha256: "",
                width: null,
                height: null,
                contentType: "text/plain",
                sizeBytes: 0,
                filename: null,
              }));
            },
          },
          taskQueue: { resume: () => void (resumeCalled += 1) },
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: { setModeAll: () => void (setModeCalled += 1) },
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {
        promoteCalled += 1;
      },
      broadcastToSession(sessionId: string, payload: unknown) {
        broadcasted.push({ sessionId, payload });
      },
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const approveReq = createReq("POST", { runQueue: false });
    const approveRes = createRes();
    const approveUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}/approve?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveReq as any, res: approveRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRes.statusCode, 200);
    const first = parseJson<{ success: boolean; createdTaskIds: string[]; draft: { status: string; approvedTaskIds: string[] } }>(approveRes.body);
    assert.equal(first.success, true);
    assert.equal(first.createdTaskIds.length, 2);
    assert.equal(first.draft.status, "approved");
    assert.deepEqual(first.draft.approvedTaskIds, first.createdTaskIds);
    assert.equal(tasksById.size, 2);
    assert.equal(broadcasted.length, 2);
    assert.equal(resumeCalled, 0);

    const approveAgainReq = createReq("POST", { runQueue: false });
    const approveAgainRes = createRes();
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveAgainReq as any, res: approveAgainRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveAgainRes.statusCode, 200);
    const second = parseJson<{ success: boolean; createdTaskIds: string[] }>(approveAgainRes.body);
    assert.equal(second.success, true);
    assert.deepEqual(second.createdTaskIds, first.createdTaskIds);
    assert.equal(tasksById.size, 2);

    const approveRunReq = createReq("POST", { runQueue: true });
    const approveRunRes = createRes();
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveRunReq as any, res: approveRunRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRunRes.statusCode, 200);
    assert.equal(setModeCalled, 0, "already approved drafts should not re-run queue side effects");
    assert.equal(resumeCalled, 0, "already approved drafts should not re-run queue side effects");
    assert.equal(promoteCalled, 0, "already approved drafts should not re-run queue side effects");
  });

  it("approves drafts without acquiring the workspace lock", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-lock-free";
    const specRef = ensureSpecFiles(workspaceRoot, "approve-without-lock");

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r-lock", specRef, tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const tasksById = new Map<string, any>();

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async () => Promise.reject(new Error("lock should not be used")) },
          taskStore: {
            createTask(input: { id: string; prompt: string; title?: string }, now: number, opts: { status: string }) {
              const task = {
                id: input.id,
                title: input.title ?? "",
                prompt: input.prompt,
                model: "auto",
                status: opts.status,
                priority: 0,
                queueOrder: 0,
                inheritContext: true,
                retryCount: 0,
                maxRetries: 0,
                createdAt: now,
              };
              tasksById.set(task.id, task);
              return task;
            },
            getTask(id: string) {
              return tasksById.get(id) ?? null;
            },
            deleteTask(id: string) {
              tasksById.delete(id);
            },
          },
          attachmentStore: {
            assignAttachmentsToTask() {},
            listAttachmentsForTask() {
              return [];
            },
          },
          taskQueue: { resume: () => {} },
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: { setModeAll: () => {} },
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {},
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const approveReq = createReq("POST", { runQueue: false });
    const approveRes = createRes();
    const approveUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}/approve?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveReq as any, res: approveRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRes.statusCode, 200);
    const payload = parseJson<{ success: boolean; createdTaskIds: string[] }>(approveRes.body);
    assert.equal(payload.success, true);
    assert.equal(payload.createdTaskIds.length, 1);
    assert.equal(tasksById.size, 1);
  });

  it("returns 200 when approval loses the race and draft is already approved", async () => {
    const auth = { userId: "u-1", username: "u" };
    const workspaceRoot = "/tmp/ws-approve-race";
    const specRef = ensureSpecFiles(workspaceRoot, "approve-race");

    const inserted = upsertTaskBundleDraft({
      authUserId: auth.userId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r-race", specRef, tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const tasksById = new Map<string, any>();
    let preApproved = false;
    let resumeCalled = 0;
    let setModeCalled = 0;
    let promoteCalled = 0;

    const deps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      allowedDirs: [],
      workspaceRoot: "/",
      taskQueueAvailable: true,
      resolveTaskContext(url: URL) {
        const w = url.searchParams.get("workspace") || "";
        return {
          workspaceRoot: w,
          sessionId: "default",
          lock: { runExclusive: async () => Promise.reject(new Error("lock should not be used")) },
          taskStore: {
            createTask(input: { id: string; prompt: string; title?: string }, now: number, opts: { status: string }) {
              if (!preApproved) {
                preApproved = true;
                approveTaskBundleDraft({ authUserId: auth.userId, draftId: inserted.id, approvedTaskIds: [input.id], now });
              }
              const task = {
                id: input.id,
                title: input.title ?? "",
                prompt: input.prompt,
                model: "auto",
                status: opts.status,
                priority: 0,
                queueOrder: 0,
                inheritContext: true,
                retryCount: 0,
                maxRetries: 0,
                createdAt: now,
              };
              tasksById.set(task.id, task);
              return task;
            },
            getTask(id: string) {
              return tasksById.get(id) ?? null;
            },
            deleteTask(id: string) {
              tasksById.delete(id);
            },
          },
          attachmentStore: {
            assignAttachmentsToTask() {},
            listAttachmentsForTask() {
              return [];
            },
          },
          taskQueue: { resume: () => void (resumeCalled += 1) },
          queueRunning: false,
          dequeueInProgress: false,
          metrics: createMetrics(),
          runController: { setModeAll: () => void (setModeCalled += 1) },
          getStatusOrchestrator() {
            return {} as any;
          },
          getTaskQueueOrchestrator() {
            return {} as any;
          },
        };
      },
      promoteQueuedTasksToPending() {
        promoteCalled += 1;
      },
      broadcastToSession() {},
      buildAttachmentRawUrl() {
        return "";
      },
    };

    const approveReq = createReq("POST", { runQueue: true });
    const approveRes = createRes();
    const approveUrl = new URL(`http://localhost/api/task-bundle-drafts/${inserted.id}/approve?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleTaskBundleDraftRoutes(
        { req: approveReq as any, res: approveRes as any, url: approveUrl, pathname: `/api/task-bundle-drafts/${inserted.id}/approve`, auth } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(approveRes.statusCode, 200);
    const payload = parseJson<{ success: boolean; createdTaskIds: string[]; draft: { status: string; approvedTaskIds: string[] } }>(approveRes.body);
    assert.equal(payload.success, true);
    assert.equal(payload.draft.status, "approved");
    assert.deepEqual(payload.createdTaskIds, payload.draft.approvedTaskIds);
    assert.equal(tasksById.size, 1);
    assert.equal(setModeCalled, 0, "race-loser should not trigger queue side effects");
    assert.equal(resumeCalled, 0, "race-loser should not trigger queue side effects");
    assert.equal(promoteCalled, 0, "race-loser should not trigger queue side effects");
  });

  it("does not downgrade approved drafts on upsert by requestId", () => {
    const authUserId = "u-1";
    const workspaceRoot = "/tmp/ws-3";

    const inserted = upsertTaskBundleDraft({
      authUserId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk",
      bundle: { version: 1, requestId: "r3", tasks: [{ prompt: "p1" }] },
      now: 10,
    });

    const approved = approveTaskBundleDraft({ authUserId, draftId: inserted.id, approvedTaskIds: ["t-1"], now: 20 });
    assert.ok(approved);
    assert.equal(approved.status, "approved");

    const upserted = upsertTaskBundleDraft({
      authUserId,
      workspaceRoot,
      sourceChatSessionId: "planner",
      sourceHistoryKey: "hk2",
      bundle: { version: 1, requestId: "r3", tasks: [{ prompt: "changed" }] },
      now: 30,
    });

    assert.equal(upserted.id, inserted.id);
    assert.equal(upserted.status, "approved");
    assert.equal(upserted.bundle?.tasks[0]?.prompt, "p1");
  });
});
