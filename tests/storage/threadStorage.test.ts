import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadStorage } from "../../server/sessions/threadStorage.js";

describe("ThreadStorage", () => {
  it("stores thread IDs per agent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));

    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "thread-storage-salt"),
    });

    storage.setThreadId(42, "codex-123", "codex");
    storage.setThreadId(42, "claude-456", "claude");

    assert.equal(storage.getThreadId(42, "codex"), "codex-123");
    assert.equal(storage.getThreadId(42, "claude"), "claude-456");

    const record = storage.getRecord(42);
    assert.deepEqual(record?.agentThreads, {
      codex: "codex-123",
      claude: "claude-456",
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isolates Telegram state from Web lane state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const options = {
      stateDbPath,
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "thread-storage-salt"),
    };
    const telegramStorage = new ThreadStorage({ ...options, namespace: "tg" });
    const webWorkerStorage = new ThreadStorage({ ...options, namespace: "web-worker" });

    telegramStorage.setThreadId(42, "tg-codex-thread", "codex");
    webWorkerStorage.setThreadId(42, "web-codex-thread", "codex");

    assert.equal(telegramStorage.getThreadId(42, "codex"), "tg-codex-thread");
    assert.equal(webWorkerStorage.getThreadId(42, "codex"), "web-codex-thread");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
