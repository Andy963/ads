import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../src/state/database.js";
import { ensureWebAuthTables } from "../../src/web/auth/schema.js";
import { ensureWebProjectTables } from "../../src/web/projects/schema.js";
import { deriveProjectSessionId } from "../../src/web/server/projectSessionId.js";
import { getTaskNotificationRow, recordTaskTerminalStatus, upsertTaskNotificationBinding } from "../../src/web/taskNotifications/store.js";
import { attemptSendTaskTerminalTelegramNotification } from "../../src/web/taskNotifications/telegramNotifier.js";

describe("web/taskNotifications telegram", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-task-notify-test-"));
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

  it("records binding with fallback project name and missing config error", () => {
    delete process.env.ADS_TELEGRAM_BOT_TOKEN;
    delete process.env.ADS_TELEGRAM_NOTIFY_CHAT_ID;

    const db = getStateDatabase();
    upsertTaskNotificationBinding({
      db,
      authUserId: "u1",
      workspaceRoot: "/tmp/my-workspace",
      taskId: "t1",
      taskTitle: "Hello",
      now: 1_000,
    });

    const row = getTaskNotificationRow({ db, taskId: "t1" });
    assert.ok(row);
    assert.equal(row.projectName, "my-workspace");
    assert.equal(row.status, "created");
    assert.equal(row.lastError, "missing_telegram_config");
  });

  it("prefers web_projects display_name at create time", () => {
    process.env.ADS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ADS_TELEGRAM_NOTIFY_CHAT_ID = "123";

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("u1", "u1", "x", now, now);

    const workspaceRoot = "/tmp/ws-project-name";
    const projectId = deriveProjectSessionId(workspaceRoot);
    db.prepare(
      `INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 0, ?, ?)`,
    ).run("u1", projectId, workspaceRoot, "My Project", now, now);

    upsertTaskNotificationBinding({
      db,
      authUserId: "u1",
      workspaceRoot,
      taskId: "t2",
      taskTitle: "Task 2",
      now,
    });

    const row = getTaskNotificationRow({ db, taskId: "t2" });
    assert.ok(row);
    assert.equal(row.projectName, "My Project");
  });

  it("sends at most once and marks notified", async () => {
    process.env.ADS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ADS_TELEGRAM_NOTIFY_CHAT_ID = "123";

    const db = getStateDatabase();
    upsertTaskNotificationBinding({
      db,
      authUserId: "u1",
      workspaceRoot: "/tmp/ws",
      taskId: "t3",
      taskTitle: "Task 3",
      now: 1_000,
    });
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t3",
      taskTitle: "Task 3",
      status: "completed",
      startedAt: 1_100,
      completedAt: 2_200,
      now: 2_200,
    });

    let calls = 0;
    const sender = async () => {
      calls += 1;
      return { ok: true as const };
    };

    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const first = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t3", sender });
    assert.equal(first, "sent");
    assert.equal(calls, 1);

    const second = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t3", sender });
    assert.equal(second, "skipped");
    assert.equal(calls, 1);

    const row = getTaskNotificationRow({ db, taskId: "t3" });
    assert.ok(row);
    assert.ok(row.notifiedAt != null && row.notifiedAt > 0);
  });

  it("records failures with retry_count and next_retry_at", async () => {
    process.env.ADS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ADS_TELEGRAM_NOTIFY_CHAT_ID = "123";

    const db = getStateDatabase();
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t4",
      taskTitle: "Task 4",
      status: "failed",
      startedAt: 1_000,
      completedAt: 2_000,
      now: 2_000,
    });

    const before = Date.now();
    const sender = async () => ({ ok: false as const, error: "boom", retryAfterSeconds: 1 });
    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const outcome = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t4", sender });
    assert.equal(outcome, "failed");

    const row = getTaskNotificationRow({ db, taskId: "t4" });
    assert.ok(row);
    assert.equal(row.retryCount, 1);
    assert.ok(row.lastError?.includes("boom"));
    assert.ok(row.nextRetryAt != null);

    const after = Date.now();
    assert.ok(row.nextRetryAt! >= before + 900);
    assert.ok(row.nextRetryAt! <= after + 5_000);
  });
});

