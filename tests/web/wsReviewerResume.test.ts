import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";
import { DirectoryManager } from "../../server/telegram/utils/directoryManager.js";
import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { ThreadStorage } from "../../server/telegram/utils/threadStorage.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { buildWsConnectionIdentity } from "../../server/web/server/ws/connectionIdentity.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";

type WsJson = { type?: unknown; [key: string]: unknown };

class FakeReviewerSession {
  invokeCount = 0;
  workingDirectory = "";
  threadId: string | null;

  constructor(threadId: string | null) {
    this.threadId = threadId;
  }

  status(): { ready: boolean; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd;
  }

  setModel(): void {}

  setModelReasoningEffort(): void {}

  getActiveAgentId(): string {
    return "codex";
  }

  listAgents(): Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }> {
    return [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }];
  }

  hasAgent(agentId: string): boolean {
    return agentId === "codex";
  }

  onEvent(): () => void {
    return () => undefined;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  reset(): void {
    this.threadId = null;
  }

  async invokeAgent(agentId: string, _input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.invokeCount += 1;
    if (!this.threadId) {
      this.threadId = "reviewer-thread";
    }
    return { response: `Review response ${this.invokeCount}`, usage: null, agentId };
  }
}

function waitForWsOpen(client: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ws open")), timeoutMs);
    client.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForWsMessage(client: WebSocket, predicate: (msg: WsJson) => boolean, timeoutMs = 2000): Promise<WsJson> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ws message")), timeoutMs);
    const handler = (raw: RawData) => {
      let parsed: WsJson | null = null;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as WsJson;
      } catch {
        return;
      }
      if (!predicate(parsed)) {
        return;
      }
      clearTimeout(timer);
      client.off("message", handler);
      resolve(parsed);
    };
    client.on("message", handler);
    client.once("error", (error) => {
      clearTimeout(timer);
      client.off("message", handler);
      reject(error);
    });
  });
}

describe("web/server/ws reviewer resume", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let reviewerSessionManager: SessionManager;
  let threadStorage: ThreadStorage;
  let reviewerCreateCalls: Array<{ cwd: string; resumeThread: boolean; resumeThreadId?: string }>;
  let reviewerSessions: FakeReviewerSession[];
  let snapshotId: string;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-reviewer-resume-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-reviewer-workspace-"));
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetStateDatabaseForTests();
    resetDatabaseForTests();

    const taskStore = new TaskStore();
    const task = taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const reviewStore = new ReviewStore();
    const snapshot = reviewStore.createSnapshot({
      taskId: task.id,
      specRef: null,
      worktreeDir: workspaceRoot,
      patch: { files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+ok\n", truncated: false },
      changedFiles: ["src/a.ts"],
      lintSummary: "",
      testSummary: "",
    });
    snapshotId = snapshot.id;

    reviewerCreateCalls = [];
    reviewerSessions = [];
    threadStorage = new ThreadStorage({
      namespace: "test-reviewer-resume",
      stateDbPath: process.env.ADS_STATE_DB_PATH,
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });

    reviewerSessionManager = new SessionManager(0, 0, "read-only", "test-model", threadStorage, undefined, {
      createSession: ((args: {
        cwd: string;
        resumeThread: boolean;
        resumeThreadId?: string;
      }) => {
        reviewerCreateCalls.push({
          cwd: args.cwd,
          resumeThread: args.resumeThread,
          resumeThreadId: args.resumeThreadId,
        });
        const session = new FakeReviewerSession(args.resumeThreadId ?? null);
        reviewerSessions.push(session);
        return session as any;
      }) as never,
    });

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<import("ws").WebSocket, any>();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    const workerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    const plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    const reviewerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-reviewer" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();

    wss = attachWebSocketServer({
      server,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      config: {
        workspaceRoot,
        allowedDirs: [workspaceRoot],
        maxClients: 10,
        pingIntervalMs: 0,
        maxMissedPongs: 0,
        traceWsDuplication: false,
      },
      auth: {
        allowedOrigins: new Set(),
        isOriginAllowed: () => true,
        authenticateRequest: () => ({ ok: true as const, userId: "review-user" }),
      },
      agents: {
        agentAvailability,
      },
      state: {
        directoryManager,
        workspaceCache: new Map(),
        sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
        interruptControllers: new Map<string, AbortController>(),
        clientMetaByWs,
        clients,
        cwdStore: new Map(),
        cwdStorePath: process.env.ADS_STATE_DB_PATH!,
        persistCwdStore: () => {},
      },
      sessions: {
        workerSessionManager,
        plannerSessionManager,
        reviewerSessionManager,
        getWorkspaceLock: () => lock,
        getPlannerWorkspaceLock: () => lock,
        getReviewerWorkspaceLock: () => lock,
      },
      history: {
        workerHistoryStore,
        plannerHistoryStore,
        reviewerHistoryStore,
      },
      tasks: {
        ensureTaskContext: () => ({ reviewStore }) as any,
        promoteQueuedTasksToPending: () => {},
        broadcastToSession: () => {},
      },
      commands: {
        runAdsCommandLine: async () => ({ ok: true, output: "" }),
        sanitizeInput: (payload) => String(payload ?? ""),
        syncWorkspaceTemplates: () => {},
      },
      scheduler: {},
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.once("error", reject);
      });
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        t.skip(`listen not permitted (${code})`);
        return;
      }
      throw error;
    }

    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    port = addr.port;
  });

  afterEach(async () => {
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    reviewerSessionManager.destroy();
    resetDatabaseForTests();
    resetStateDatabaseForTests();
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

  it("resumes a saved reviewer thread on reconnect only after snapshot context has been bound", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.review-session", "ads-chat.reviewer"];

    const firstClient = new WebSocket(url, protocols, { origin: "http://localhost" });
    const firstWelcomePromise = waitForWsMessage(firstClient, (msg) => msg.type === "welcome");
    await waitForWsOpen(firstClient);
    const firstWelcome = await firstWelcomePromise;
    assert.equal(firstWelcome.threadId, null);

    const bindingPromise = waitForWsMessage(
      firstClient,
      (msg) => msg.type === "reviewer_snapshot_binding" && msg.snapshotId === snapshotId,
    );
    const resultPromise = waitForWsMessage(
      firstClient,
      (msg) => msg.type === "result" && typeof msg.output === "string" && String(msg.output).includes("Review response"),
    );
    firstClient.send(JSON.stringify({ type: "prompt", payload: { text: "Please review", snapshotId } }));
    await bindingPromise;
    await resultPromise;

    const userId = buildWsConnectionIdentity({
      authUserId: "review-user",
      sessionId: "review-session",
      chatSessionId: "reviewer",
    }).userId;
    assert.equal(threadStorage.getRecord(userId)?.agentThreads?.codex, "reviewer-thread");
    assert.equal(threadStorage.getRecord(userId)?.reviewerSnapshotId, snapshotId);
    assert.deepEqual(
      reviewerCreateCalls.map((call) => ({ cwd: call.cwd, resumeThread: call.resumeThread, resumeThreadId: call.resumeThreadId })),
      [{ cwd: workspaceRoot, resumeThread: false, resumeThreadId: undefined }],
    );

    firstClient.terminate();
    reviewerSessionManager.dropSession(userId);

    const reconnectClient = new WebSocket(url, protocols, { origin: "http://localhost" });
    const reconnectWelcomePromise = waitForWsMessage(reconnectClient, (msg) => msg.type === "welcome");
    const replayedBindingPromise = waitForWsMessage(
      reconnectClient,
      (msg) => msg.type === "reviewer_snapshot_binding" && msg.snapshotId === snapshotId,
    );
    await waitForWsOpen(reconnectClient);
    const reconnectWelcome = await reconnectWelcomePromise;
    assert.equal(reconnectWelcome.threadId, "reviewer-thread");
    assert.equal(reconnectWelcome.contextMode, "thread_resumed");

    const replayedBinding = await replayedBindingPromise;
    assert.equal(replayedBinding.snapshotId, snapshotId);
    assert.deepEqual(
      reviewerCreateCalls.map((call) => ({ cwd: call.cwd, resumeThread: call.resumeThread, resumeThreadId: call.resumeThreadId })),
      [
        { cwd: workspaceRoot, resumeThread: false, resumeThreadId: undefined },
        { cwd: workspaceRoot, resumeThread: true, resumeThreadId: "reviewer-thread" },
      ],
    );

    reconnectClient.terminate();
  });

  it("restores reviewer continuity after the server-side snapshot binding state is recreated", async (t) => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.review-session", "ads-chat.reviewer"];

    const firstClient = new WebSocket(url, protocols, { origin: "http://localhost" });
    const bindingPromise = waitForWsMessage(
      firstClient,
      (msg) => msg.type === "reviewer_snapshot_binding" && msg.snapshotId === snapshotId,
    );
    const resultPromise = waitForWsMessage(
      firstClient,
      (msg) => msg.type === "result" && typeof msg.output === "string" && String(msg.output).includes("Review response"),
    );
    await waitForWsOpen(firstClient);
    firstClient.send(JSON.stringify({ type: "prompt", payload: { text: "Please review", snapshotId } }));
    await bindingPromise;
    await resultPromise;

    const userId = buildWsConnectionIdentity({
      authUserId: "review-user",
      sessionId: "review-session",
      chatSessionId: "reviewer",
    }).userId;
    assert.equal(threadStorage.getRecord(userId)?.threadId, "reviewer-thread");
    assert.equal(threadStorage.getRecord(userId)?.reviewerSnapshotId, snapshotId);

    firstClient.terminate();
    reviewerSessionManager.dropSession(userId);

    const recreatedThreadStorage = new ThreadStorage({
      namespace: "test-reviewer-resume",
      stateDbPath: process.env.ADS_STATE_DB_PATH,
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    const recreatedReviewerCreateCalls: Array<{ cwd: string; resumeThread: boolean; resumeThreadId?: string }> = [];
    const recreatedReviewerSessionManager = new SessionManager(
      0,
      0,
      "read-only",
      "test-model",
      recreatedThreadStorage,
      undefined,
      {
        createSession: ((args: {
          cwd: string;
          resumeThread: boolean;
          resumeThreadId?: string;
        }) => {
          recreatedReviewerCreateCalls.push({
            cwd: args.cwd,
            resumeThread: args.resumeThread,
            resumeThreadId: args.resumeThreadId,
          });
          return new FakeReviewerSession(args.resumeThreadId ?? null) as any;
        }) as never,
      },
    );
    const recreatedWorkerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const recreatedPlannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const recreatedServer = http.createServer();
    const recreatedClients = new Set<import("ws").WebSocket>();
    const recreatedClientMetaByWs = new Map<import("ws").WebSocket, any>();
    const recreatedDirectoryManager = new DirectoryManager([workspaceRoot]);
    const recreatedWorkerHistoryStore = new HistoryStore({
      storagePath: process.env.ADS_STATE_DB_PATH,
      namespace: "test-worker",
    });
    const recreatedPlannerHistoryStore = new HistoryStore({
      storagePath: process.env.ADS_STATE_DB_PATH,
      namespace: "test-planner",
    });
    const recreatedReviewerHistoryStore = new HistoryStore({
      storagePath: process.env.ADS_STATE_DB_PATH,
      namespace: "test-reviewer",
    });
    const recreatedLock = new AsyncLock();
    const recreatedReviewStore = new ReviewStore();
    const recreatedWss = attachWebSocketServer({
      server: recreatedServer,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      config: {
        workspaceRoot,
        allowedDirs: [workspaceRoot],
        maxClients: 10,
        pingIntervalMs: 0,
        maxMissedPongs: 0,
        traceWsDuplication: false,
      },
      auth: {
        allowedOrigins: new Set(),
        isOriginAllowed: () => true,
        authenticateRequest: () => ({ ok: true as const, userId: "review-user" }),
      },
      agents: {
        agentAvailability: new NoopAgentAvailability(),
      },
      state: {
        directoryManager: recreatedDirectoryManager,
        workspaceCache: new Map(),
        sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
        interruptControllers: new Map<string, AbortController>(),
        clientMetaByWs: recreatedClientMetaByWs,
        clients: recreatedClients,
        cwdStore: new Map(),
        cwdStorePath: process.env.ADS_STATE_DB_PATH!,
        persistCwdStore: () => {},
      },
      sessions: {
        workerSessionManager: recreatedWorkerSessionManager,
        plannerSessionManager: recreatedPlannerSessionManager,
        reviewerSessionManager: recreatedReviewerSessionManager,
        getWorkspaceLock: () => recreatedLock,
        getPlannerWorkspaceLock: () => recreatedLock,
        getReviewerWorkspaceLock: () => recreatedLock,
      },
      history: {
        workerHistoryStore: recreatedWorkerHistoryStore,
        plannerHistoryStore: recreatedPlannerHistoryStore,
        reviewerHistoryStore: recreatedReviewerHistoryStore,
      },
      tasks: {
        ensureTaskContext: () => ({ reviewStore: recreatedReviewStore }) as any,
        promoteQueuedTasksToPending: () => {},
        broadcastToSession: () => {},
      },
      commands: {
        runAdsCommandLine: async () => ({ ok: true, output: "" }),
        sanitizeInput: (payload) => String(payload ?? ""),
        syncWorkspaceTemplates: () => {},
      },
      scheduler: {},
    });

    let recreatedClient: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        recreatedServer.listen(0, "127.0.0.1", () => resolve());
        recreatedServer.once("error", reject);
      });
    } catch (error) {
      try {
        recreatedWss.close();
      } catch {
        // ignore
      }
      recreatedReviewerSessionManager.destroy();
      recreatedWorkerSessionManager.destroy();
      recreatedPlannerSessionManager.destroy();
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        t.skip(`listen not permitted (${code})`);
        return;
      }
      throw error;
    }

    try {
      const addr = recreatedServer.address();
      assert.ok(addr && typeof addr === "object");
      recreatedClient = new WebSocket(`ws://127.0.0.1:${addr.port}`, protocols, { origin: "http://localhost" });
      const welcomePromise = waitForWsMessage(recreatedClient, (msg) => msg.type === "welcome");
      const replayedBindingPromise = waitForWsMessage(
        recreatedClient,
        (msg) => msg.type === "reviewer_snapshot_binding" && msg.snapshotId === snapshotId,
      );
      await waitForWsOpen(recreatedClient);
      const welcome = await welcomePromise;
      assert.equal(welcome.threadId, "reviewer-thread");
      assert.equal(welcome.contextMode, "thread_resumed");

      const replayedBinding = await replayedBindingPromise;
      assert.equal(replayedBinding.snapshotId, snapshotId);
      assert.deepEqual(recreatedReviewerCreateCalls, [
        { cwd: workspaceRoot, resumeThread: true, resumeThreadId: "reviewer-thread" },
      ]);
    } finally {
      recreatedClient?.terminate();
      try {
        recreatedWss.close();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        try {
          recreatedServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      recreatedReviewerSessionManager.destroy();
      recreatedWorkerSessionManager.destroy();
      recreatedPlannerSessionManager.destroy();
    }
  });
});
