import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor from "better-sqlite3";

import { createPromptQueueStore, type PromptQueueEntry } from "../../server/state/promptQueueStore.js";
import { buildClientMessageHistoryKind } from "../../server/utils/historyKind.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { getPromptQueueHistoryOutcome } from "../../server/web/server/promptQueueHistory.js";
import { PromptQueueService } from "../../server/web/server/promptQueueService.js";

describe("web/promptQueueService", () => {
  it("recovers accepted work after a process boundary and runs it FIFO", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-service-"));
    const dbPath = path.join(tempDir, "state.db");
    const firstDb = new DatabaseConstructor(dbPath);
    const firstStore = createPromptQueueStore(firstDb);
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey: "auth-1::session-1::main:generation:1",
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    firstStore.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    const interrupted = firstStore.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });
    firstStore.enqueue({ ...lane, clientMessageId: "client-3", payload: { text: "three" } });
    firstStore.claimOwnership("old-worker", 1111, Date.now());
    assert.equal(firstStore.markRunning(interrupted.entry.id, "old-worker"), true);
    firstDb.close();

    const secondDb = new DatabaseConstructor(dbPath);
    const secondStore = createPromptQueueStore(secondDb);
    const executed: string[] = [];
    const service = new PromptQueueService({
      store: secondStore,
      workerId: "new-worker",
      ownerPid: 2222,
      isOwnerAlive: () => false,
      resolveCurrentGeneration: () => 1,
      runPrompt: async (entry: PromptQueueEntry) => {
        executed.push(entry.clientMessageId);
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["client-1", "client-3"]);
    assert.equal(secondStore.getByClientMessageId("client-1")?.status, "completed");
    assert.equal(secondStore.getByClientMessageId("client-2")?.status, "failed");
    assert.match(String(secondStore.getByClientMessageId("client-2")?.lastError), /interrupted before completion/);
    assert.equal(secondStore.getByClientMessageId("client-3")?.status, "completed");
    await service.stop();
    secondDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs different lanes concurrently while preserving FIFO within each lane", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-lanes-"));
    const db = new DatabaseConstructor(path.join(tempDir, "state.db"));
    const store = createPromptQueueStore(db);
    const firstLane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey: "auth-1::session-1::main:generation:1",
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    const secondLane = {
      ...firstLane,
      historyKey: "auth-1::session-1::main:generation:2",
      laneGeneration: 2,
    };
    store.enqueue({ ...firstLane, clientMessageId: "first-1", payload: { text: "first-1" } });
    store.enqueue({ ...firstLane, clientMessageId: "first-2", payload: { text: "first-2" } });
    store.enqueue({ ...secondLane, clientMessageId: "second-1", payload: { text: "second-1" } });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executed: string[] = [];
    const service = new PromptQueueService({
      store,
      workerId: "worker-1",
      ownerPid: 2222,
      resolveCurrentGeneration: (entry) => entry.laneGeneration,
      runPrompt: async (entry) => {
        executed.push(entry.clientMessageId);
        if (entry.clientMessageId === "first-1") {
          await firstGate;
        }
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["first-1", "second-1"]);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["first-1", "second-1", "first-2"]);
    assert.equal(store.getByClientMessageId("first-2")?.status, "completed");
    await service.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("waits for the active lane during shutdown and leaves queued work recoverable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-stop-"));
    const db = new DatabaseConstructor(path.join(tempDir, "state.db"));
    const store = createPromptQueueStore(db);
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey: "auth-1::session-1::main:generation:1",
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    store.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });

    let releaseFirst!: () => void;
    let notifyFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const executed: string[] = [];
    const firstService = new PromptQueueService({
      store,
      workerId: "worker-1",
      ownerPid: 2222,
      resolveCurrentGeneration: (entry) => entry.laneGeneration,
      runPrompt: async (entry) => {
        executed.push(entry.clientMessageId);
        if (entry.clientMessageId === "client-1") {
          notifyFirstStarted();
          await firstGate;
        }
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await firstService.start();
    await firstStarted;

    let stopped = false;
    const stopping = firstService.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    assert.deepEqual(executed, ["client-1"]);

    releaseFirst();
    await stopping;
    assert.equal(store.getByClientMessageId("client-1")?.status, "completed");
    assert.equal(store.getByClientMessageId("client-2")?.status, "queued");

    const secondService = new PromptQueueService({
      store,
      workerId: "worker-2",
      ownerPid: 3333,
      resolveCurrentGeneration: (entry) => entry.laneGeneration,
      runPrompt: async (entry) => {
        executed.push(entry.clientMessageId);
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await secondService.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["client-1", "client-2"]);
    assert.equal(store.getByClientMessageId("client-2")?.status, "completed");
    await secondService.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reconciles persisted terminal history after a process boundary without executing again", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-terminal-"));
    const dbPath = path.join(tempDir, "state.db");
    const firstDb = new DatabaseConstructor(dbPath);
    const firstStore = createPromptQueueStore(firstDb);
    const historyKey = "auth-1::session-1::main:generation:1";
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey,
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    const interrupted = firstStore.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    firstStore.claimOwnership("old-worker", 1111, Date.now());
    assert.equal(firstStore.markRunning(interrupted.entry.id, "old-worker"), true);
    const firstHistory = new HistoryStore({ storagePath: dbPath, namespace: "test-worker" });
    const kind = buildClientMessageHistoryKind({ clientMessageId: "client-1" });
    firstHistory.add(historyKey, { role: "user", text: "one", ts: 1000, kind });
    firstHistory.add(historyKey, { role: "ai", text: "done", ts: 1100 });
    firstDb.close();

    const secondDb = new DatabaseConstructor(dbPath);
    const secondStore = createPromptQueueStore(secondDb);
    const secondHistory = new HistoryStore({ storagePath: dbPath, namespace: "test-worker" });
    let executions = 0;
    const service = new PromptQueueService({
      store: secondStore,
      workerId: "new-worker",
      ownerPid: 2222,
      isOwnerAlive: () => false,
      resolveCurrentGeneration: () => 1,
      reconcileBeforeRun: async (entry) => (
        getPromptQueueHistoryOutcome(secondHistory.get(entry.historyKey), entry.clientMessageId) === "completed"
          ? { ok: true }
          : null
      ),
      runPrompt: async () => {
        executions += 1;
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(executions, 0);
    assert.equal(secondStore.getByClientMessageId("client-1")?.status, "completed");
    assert.deepEqual(secondStore.getByClientMessageId("client-1")?.payload, {});
    await service.stop();
    secondDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("restores a persisted error as failed so an explicit retry remains possible", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-error-"));
    const dbPath = path.join(tempDir, "state.db");
    const firstDb = new DatabaseConstructor(dbPath);
    const firstStore = createPromptQueueStore(firstDb);
    const historyKey = "auth-1::session-1::main:generation:1";
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey,
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    const interrupted = firstStore.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    firstStore.claimOwnership("old-worker", 1111, Date.now());
    assert.equal(firstStore.markRunning(interrupted.entry.id, "old-worker"), true);
    const firstHistory = new HistoryStore({ storagePath: dbPath, namespace: "test-worker" });
    const kind = buildClientMessageHistoryKind({ clientMessageId: "client-1" });
    firstHistory.add(historyKey, { role: "user", text: "one", ts: 1000, kind });
    firstHistory.add(historyKey, { role: "status", text: "failed", ts: 1100, kind: "error" });
    firstDb.close();

    const secondDb = new DatabaseConstructor(dbPath);
    const secondStore = createPromptQueueStore(secondDb);
    const secondHistory = new HistoryStore({ storagePath: dbPath, namespace: "test-worker" });
    let executions = 0;
    const service = new PromptQueueService({
      store: secondStore,
      workerId: "new-worker",
      ownerPid: 2222,
      isOwnerAlive: () => false,
      resolveCurrentGeneration: () => 1,
      reconcileBeforeRun: async (entry) => {
        const outcome = getPromptQueueHistoryOutcome(secondHistory.get(entry.historyKey), entry.clientMessageId);
        return outcome === "completed" ? { ok: true } : outcome === "failed" ? { ok: false, error: "failed" } : null;
      },
      runPrompt: async () => {
        executions += 1;
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const recovered = secondStore.getByClientMessageId("client-1");
    assert.equal(executions, 0);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.payload.text, "one");
    await service.stop();
    secondDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes obsolete-generation failures in the current logical lane snapshot", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-generation-"));
    const db = new DatabaseConstructor(path.join(tempDir, "state.db"));
    const store = createPromptQueueStore(db);
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey: "auth-1::session-1::main",
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    store.enqueue({ ...lane, clientMessageId: "old-generation", payload: { text: "old" } });
    const service = new PromptQueueService({
      store,
      workerId: "worker-1",
      resolveCurrentGeneration: () => 2,
      runPrompt: async () => ({ ok: true }),
      emitSnapshot: () => undefined,
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = service.getSnapshot({ ...lane, historyKey: `${lane.logicalHistoryKey}:generation:2`, laneGeneration: 2 });
    assert.equal(store.getByClientMessageId("old-generation")?.status, "failed");
    assert.deepEqual(snapshot.map((entry) => entry.clientMessageId), ["old-generation"]);
    await service.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("aborts active work and fences terminal writes after ownership is reclaimed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-queue-owner-fence-"));
    const db = new DatabaseConstructor(path.join(tempDir, "state.db"));
    const store = createPromptQueueStore(db);
    const lane = {
      authUserId: "auth-1",
      userId: 7,
      sessionId: "session-1",
      chatSessionId: "main",
      historyKey: "auth-1::session-1::main:generation:1",
      logicalHistoryKey: "auth-1::session-1::main",
      laneNamespace: "auth-1::session-1",
      laneGeneration: 1,
      workspaceRoot: "/workspace/project",
    };
    store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });

    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const errors: string[] = [];
    const service = new PromptQueueService({
      store,
      workerId: "worker-1",
      ownerPid: 1111,
      isOwnerAlive: () => true,
      ownershipRenewalIntervalMs: 10,
      resolveCurrentGeneration: (entry) => entry.laneGeneration,
      runPrompt: async () => {
        started();
        await runGate;
        return { ok: true };
      },
      abortRun: () => {
        aborted = true;
        releaseRun();
      },
      emitSnapshot: () => undefined,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    await service.start();
    await runStarted;

    assert.equal(store.claimOwnership("worker-2", 2222, Date.now(), 60_000, () => false).claimed, true);
    for (let attempt = 0; attempt < 100 && !aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await service.stop();

    assert.equal(aborted, true);
    assert.equal(errors.some((message) => message.includes("renewal failed")), true);
    assert.equal(store.getByClientMessageId("client-1")?.status, "running");
    assert.equal(store.markCompleted(store.getByClientMessageId("client-1")!.id, "worker-1"), false);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
