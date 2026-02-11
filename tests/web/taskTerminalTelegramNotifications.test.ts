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
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USERS;

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
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";

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
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";

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
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";

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

  it("uses TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS for notifications", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";

    const db = getStateDatabase();
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t5",
      taskTitle: "Task 5",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      now: 2_000,
    });

    let calls = 0;
    const sender = async (args: { botToken: string; chatId: string; text: string }) => {
      calls += 1;
      assert.equal(args.botToken, "test-token");
      assert.equal(args.chatId, "123");
      assert.ok(args.text.includes("Task terminal"));
      return { ok: true as const };
    };

    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const outcome = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t5", sender });
    assert.equal(outcome, "sent");
    assert.equal(calls, 1);
  });

  it("formats timestamps in Asia/Shanghai and omits TaskId line", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    delete process.env.ADS_TELEGRAM_NOTIFY_TIMEZONE;

    const db = getStateDatabase();
    const startedAt = Date.UTC(2026, 1, 11, 12, 34, 56);
    const completedAt = startedAt + 1_000;
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t6",
      taskTitle: "Task 6",
      status: "completed",
      startedAt,
      completedAt,
      now: completedAt,
    });

    const sender = async (args: { botToken: string; chatId: string; text: string }) => {
      assert.ok(args.text.includes("Started: 2026-02-11 20:34:56"));
      assert.ok(args.text.includes("Completed: 2026-02-11 20:34:57"));
      assert.ok(!args.text.includes("TaskId:"));
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(args.text));
      assert.ok(!/Z\b/.test(args.text));

      const lines = args.text.split("\n");
      const startedLine = lines.find((line) => line.startsWith("Started: "));
      const completedLine = lines.find((line) => line.startsWith("Completed: "));
      assert.ok(startedLine);
      assert.ok(completedLine);
      assert.match(startedLine, /^Started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.match(completedLine, /^Completed: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      return { ok: true as const };
    };

    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const outcome = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t6", sender });
    assert.equal(outcome, "sent");
  });

  it("uses ADS_TELEGRAM_NOTIFY_TIMEZONE when valid", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.ADS_TELEGRAM_NOTIFY_TIMEZONE = "UTC";

    const db = getStateDatabase();
    const startedAt = Date.UTC(2026, 1, 11, 12, 34, 56);
    const completedAt = startedAt + 1_000;
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t7",
      taskTitle: "Task 7",
      status: "completed",
      startedAt,
      completedAt,
      now: completedAt,
    });

    const sender = async (args: { botToken: string; chatId: string; text: string }) => {
      assert.ok(args.text.includes("Started: 2026-02-11 12:34:56"));
      assert.ok(args.text.includes("Completed: 2026-02-11 12:34:57"));
      assert.ok(!args.text.includes("TaskId:"));
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(args.text));
      assert.ok(!/Z\b/.test(args.text));
      return { ok: true as const };
    };

    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const outcome = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t7", sender });
    assert.equal(outcome, "sent");
  });

  it("falls back to Asia/Shanghai on invalid ADS_TELEGRAM_NOTIFY_TIMEZONE", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "123";
    process.env.ADS_TELEGRAM_NOTIFY_TIMEZONE = "Invalid/Zone";

    const db = getStateDatabase();
    const startedAt = Date.UTC(2026, 1, 11, 12, 34, 56);
    const completedAt = startedAt + 1_000;
    recordTaskTerminalStatus({
      db,
      workspaceRoot: "/tmp/ws",
      taskId: "t8",
      taskTitle: "Task 8",
      status: "completed",
      startedAt,
      completedAt,
      now: completedAt,
    });

    const sender = async (args: { botToken: string; chatId: string; text: string }) => {
      assert.ok(args.text.includes("Started: 2026-02-11 20:34:56"));
      assert.ok(args.text.includes("Completed: 2026-02-11 20:34:57"));
      assert.ok(!args.text.includes("TaskId:"));
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(args.text));
      assert.ok(!/Z\b/.test(args.text));
      return { ok: true as const };
    };

    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const outcome = await attemptSendTaskTerminalTelegramNotification({ logger, taskId: "t8", sender });
    assert.equal(outcome, "sent");
  });
});
