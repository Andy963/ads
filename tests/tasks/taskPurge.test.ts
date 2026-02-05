import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import { AttachmentStore } from "../../src/attachments/store.js";

describe("tasks/taskPurge", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-purge-"));
    dbPath = path.join(tmpDir, "tasks.db");
    process.env.ADS_DATABASE_PATH = dbPath;
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
  });

  it("should purge archived completed tasks and detach children", () => {
    const store = new TaskStore();
    const attachmentStore = new AttachmentStore();

    const parent = store.createTask({ title: "P", prompt: "P" });
    const child = store.createTask({ title: "C", prompt: "C", parentTaskId: parent.id });

    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    store.updateTask(parent.id, { status: "completed" }, eightDaysAgo);

    const attachment = attachmentStore.createOrGetImageAttachment({
      taskId: parent.id,
      filename: "a.png",
      contentType: "image/png",
      sizeBytes: 1,
      width: 1,
      height: 1,
      sha256: "a".repeat(64),
      storageKey: "attachments/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      now: eightDaysAgo,
    });

    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const purged = store.purgeArchivedCompletedTasksBatch(cutoff, { limit: 50 });

    assert.deepEqual(purged.taskIds, [parent.id]);
    assert.equal(store.getTask(parent.id), null);
    assert.equal(attachmentStore.getAttachment(attachment.id), null);

    const fetchedChild = store.getTask(child.id);
    assert.ok(fetchedChild);
    assert.equal(fetchedChild.parentTaskId, null);

    assert.ok(purged.attachments.some((a) => a.id === attachment.id));
  });
});

