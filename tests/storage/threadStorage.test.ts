import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ThreadStorage } from "../../src/telegram/utils/threadStorage.js";

describe("ThreadStorage", () => {
  it("stores thread IDs per agent", () => {
    const scratchRoot = path.join(process.cwd(), ".ads-test-tmp");
    fs.mkdirSync(scratchRoot, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(scratchRoot, "thread-storage-"));

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
});
