import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor from "better-sqlite3";

import { createPromptQueueStore, type PromptQueueEntry } from "../../server/state/promptQueueStore.js";
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
    const first = firstStore.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    firstStore.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });
    assert.equal(firstStore.markRunning(first.entry.id, "old-worker"), true);
    firstDb.close();

    const secondDb = new DatabaseConstructor(dbPath);
    const secondStore = createPromptQueueStore(secondDb);
    const executed: string[] = [];
    const service = new PromptQueueService({
      store: secondStore,
      workerId: "new-worker",
      resolveCurrentGeneration: () => 1,
      runPrompt: async (entry: PromptQueueEntry) => {
        executed.push(entry.clientMessageId);
        return { ok: true };
      },
      emitSnapshot: () => undefined,
    });
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["client-1", "client-2"]);
    assert.equal(secondStore.getByClientMessageId("client-1")?.status, "completed");
    assert.equal(secondStore.getByClientMessageId("client-2")?.status, "completed");
    service.stop();
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
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["first-1", "second-1"]);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(executed, ["first-1", "second-1", "first-2"]);
    assert.equal(store.getByClientMessageId("first-2")?.status, "completed");
    service.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
