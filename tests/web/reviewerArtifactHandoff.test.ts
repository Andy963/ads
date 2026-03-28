import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";
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

describe("web reviewer artifact handoff", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-handoff-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-handoff-workspace-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists explicit reviewer artifact references onto created worker tasks", async () => {
    const taskStore = new TaskStore({ workspacePath: workspaceRoot } as any);
    const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });
    const sourceTask = taskStore.createTask({ title: "Source", prompt: "Review me", model: "auto" });
    const snapshot = reviewStore.createSnapshot({
      taskId: sourceTask.id,
      specRef: null,
      worktreeDir: workspaceRoot,
      patch: null,
      changedFiles: ["src/a.ts"],
    });
    const artifact = reviewStore.createArtifact({
      taskId: sourceTask.id,
      snapshotId: snapshot.id,
      scope: "reviewer",
      promptText: "review",
      responseText: "Use the guard clause pattern.",
      summaryText: "Use the guard clause pattern.",
      verdict: "analysis",
    });

    const taskCtx = {
      sessionId: "workspace-1",
      workspaceRoot,
      queueRunning: false,
      reviewStore,
      taskStore,
      attachmentStore: { assignAttachmentsToTask() {}, listAttachmentsForTask() { return []; } },
      metrics: { counts: {} as any, events: [] },
      runController: { getMode: () => "manual" },
      taskQueue: {},
      getLock: () => ({ isBusy: () => false, runExclusive: async <T>(fn: () => Promise<T> | T) => await fn() }),
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot,
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

    const req = createReq("POST", {
      title: "Worker follow-up",
      prompt: "Apply the reviewer guidance",
      reviewArtifactId: artifact.id,
      reviewSnapshotId: snapshot.id,
    });
    const res = createRes();
    const url = new URL(`http://localhost/api/tasks?workspace=${encodeURIComponent(workspaceRoot)}`);
    const routeCtx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(routeCtx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 201);

    const created = JSON.parse(res.body) as { id: string };
    const contexts = taskStore.getContext(created.id);
    const reviewCtx = contexts.find((entry) => entry.contextType === "artifact:review_artifact_reference");
    assert.ok(reviewCtx);
    const payload = JSON.parse(reviewCtx!.content) as { reviewArtifactId: string; snapshotId: string; summaryText: string };
    assert.equal(payload.reviewArtifactId, artifact.id);
    assert.equal(payload.snapshotId, snapshot.id);
    assert.equal(payload.summaryText, "Use the guard clause pattern.");
  });

  it("rejects invalid reviewer artifact references without creating a task", async () => {
    const taskStore = new TaskStore({ workspacePath: workspaceRoot } as any);
    const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });
    const taskCtx = {
      sessionId: "workspace-1",
      workspaceRoot,
      queueRunning: false,
      reviewStore,
      taskStore,
      attachmentStore: { assignAttachmentsToTask() {}, listAttachmentsForTask() { return []; } },
      metrics: { counts: {} as any, events: [] },
      runController: { getMode: () => "manual" },
      taskQueue: {},
      getLock: () => ({ isBusy: () => false, runExclusive: async <T>(fn: () => Promise<T> | T) => await fn() }),
    };

    const deps: ApiSharedDeps = {
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
      allowedDirs: [],
      workspaceRoot,
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

    const req = createReq("POST", {
      title: "Worker follow-up",
      prompt: "Apply the reviewer guidance",
      reviewArtifactId: "missing-artifact",
    });
    const res = createRes();
    const url = new URL(`http://localhost/api/tasks?workspace=${encodeURIComponent(workspaceRoot)}`);
    const routeCtx: ApiRouteContext = {
      req: req as any,
      res: res as any,
      url,
      pathname: url.pathname,
      auth: { userId: "u", username: "u" },
    };

    const handled = await handleTaskRoutes(routeCtx, deps);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Unknown review artifact/);
    assert.equal(taskStore.listTasks({ limit: 10 }).length, 0);
  });
});
