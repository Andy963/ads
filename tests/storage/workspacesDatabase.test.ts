import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AttachmentStore } from "../../server/attachments/store.js";
import { ScheduleStore } from "../../server/scheduler/store.js";
import { getDatabase, getWorkspacesDatabase, resetDatabaseForTests } from "../../server/storage/database.js";
import { migrateLegacyWorkspacesToCentralDb } from "../../server/storage/legacyWorkspaceMigration.js";
import { TaskStore } from "../../server/tasks/store.js";
import { deriveWorkspaceStateId } from "../../server/workspace/adsPaths.js";

describe("storage/workspaces database", () => {
  let root: string;
  let workspaceA: string;
  let workspaceB: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspaces-db-"));
    workspaceA = path.join(root, "workspace-a");
    workspaceB = path.join(root, "workspace-b");
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    delete process.env.ADS_DATABASE_PATH;
    process.env.ADS_STATE_DIR = path.join(root, "state");
    process.env.ADS_WORKSPACES_DATABASE_PATH = path.join(root, "state", "workspaces.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("isolates task, schedule, and attachment reads by workspace", () => {
    const taskA = new TaskStore({ workspacePath: workspaceA }).createTask({ id: "task-a", title: "A", prompt: "A" });
    const storeB = new TaskStore({ workspacePath: workspaceB });
    assert.equal(storeB.getTask(taskA.id), null);
    assert.deepEqual(storeB.listTasks(), []);

    const scheduleA = new ScheduleStore({ workspacePath: workspaceA }).createSchedule({
      instruction: "Run A",
      spec: {
        version: 1,
        name: "schedule-a",
        schedule: { type: "cron", cron: "0 0 * * *", timezone: "UTC" },
        instruction: "Run A",
        delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
        compiledTask: { title: "A", prompt: "A", expectedResultSchema: {}, verification: { commands: [] } },
        policy: { workspaceWrite: false, network: "deny", maxDurationMs: 600000, maxRetries: 0, concurrencyKey: "schedule:{scheduleId}", idempotencyKeyTemplate: "{scheduleId}:{runAtIso}" },
        enabled: true,
        questions: [],
      },
      enabled: true,
      nextRunAt: 1,
    });
    const scheduleStoreB = new ScheduleStore({ workspacePath: workspaceB });
    assert.equal(scheduleStoreB.getSchedule(scheduleA.id), null);
    const externalId = "shared-run-id";
    assert.equal(new ScheduleStore({ workspacePath: workspaceA }).insertRun({ scheduleId: scheduleA.id, externalId, runAt: 1, taskId: null, status: "queued" }).inserted, true);
    const scheduleB = scheduleStoreB.createSchedule({
      instruction: "Run B",
      spec: {
        version: 1, name: "schedule-b", enabled: true,
        schedule: { type: "cron", cron: "0 0 * * *", timezone: "UTC" }, instruction: "Run B",
        delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
        compiledTask: { title: "B", prompt: "B", expectedResultSchema: {}, verification: { commands: [] } },
        policy: { workspaceWrite: false, network: "deny", maxDurationMs: 600000, maxRetries: 0, concurrencyKey: "schedule:{scheduleId}", idempotencyKeyTemplate: "{scheduleId}:{runAtIso}" },
        questions: [],
      },
      enabled: true,
      nextRunAt: 1,
    });
    assert.equal(scheduleStoreB.insertRun({ scheduleId: scheduleB.id, externalId, runAt: 1, taskId: null, status: "queued" }).inserted, true);

    const attachmentA = new AttachmentStore({ workspacePath: workspaceA }).createOrGetImageAttachment({
      contentType: "image/png", sizeBytes: 1, width: 1, height: 1,
      sha256: "a".repeat(64), storageKey: "attachments/a.png",
    });
    const attachmentStoreB = new AttachmentStore({ workspacePath: workspaceB });
    assert.equal(attachmentStoreB.getAttachment(attachmentA.id), null);
    const attachmentB = attachmentStoreB.createOrGetImageAttachment({
      contentType: "image/png", sizeBytes: 1, width: 1, height: 1,
      sha256: "a".repeat(64), storageKey: "attachments/b.png",
    });
    assert.notEqual(attachmentB.id, attachmentA.id);

    const conversationA = new TaskStore({ workspacePath: workspaceA }).upsertConversation({ id: "shared-conversation", title: "A" });
    assert.equal(conversationA.title, "A");
    assert.throws(
      () => new TaskStore({ workspacePath: workspaceB }).upsertConversation({ id: "shared-conversation", title: "B" }),
      /collision across workspaces/,
    );
    assert.equal(new TaskStore({ workspacePath: workspaceA }).getConversation("shared-conversation")?.title, "A");

    assert.throws(
      () => storeB.addMessage({
        taskId: taskA.id,
        planStepId: null,
        role: "user",
        content: "cross-workspace reference",
        createdAt: 1,
      }),
      /task_messages.task_id workspace mismatch/,
    );
  });

  it("imports a legacy workspace database once without modifying the source", () => {
    const workspacesDir = path.join(root, "legacy-workspaces");
    const workspaceId = deriveWorkspaceStateId(workspaceA);
    const sourceDir = path.join(workspacesDir, workspaceId);
    const sourcePath = path.join(sourceDir, "ads.db");
    fs.mkdirSync(sourceDir, { recursive: true });

    process.env.ADS_DATABASE_PATH = sourcePath;
    resetDatabaseForTests();
    const legacyDb = getDatabase();
    legacyDb.prepare("INSERT INTO tasks (id, title, prompt, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-task", "Legacy", "Legacy prompt", "auto", "pending", 1);
    legacyDb.prepare("INSERT INTO review_settings (workspace_id, automation_mode, max_rework_rounds, updated_at) VALUES (?, ?, ?, ?)")
      .run("legacy-workspace", "human_gated", 1, 2);
    legacyDb.prepare("INSERT INTO review_action_audits (workspace_id, id, task_id, root_task_id, action, reason, actor_id, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-workspace", "audit-1", "legacy-task", "legacy-task", "skip_review", "legacy", "user-1", "legacy-key", 3);
    resetDatabaseForTests();
    delete process.env.ADS_DATABASE_PATH;

    const before = fs.statSync(sourcePath);
    const central = getWorkspacesDatabase();
    const first = migrateLegacyWorkspacesToCentralDb(central, { workspacesDir });
    const second = migrateLegacyWorkspacesToCentralDb(central, { workspacesDir });

    assert.equal(first.length, 1);
    assert.deepEqual(second, []);
    assert.equal(new TaskStore({ workspacePath: workspaceA }).getTask("legacy-task")?.title, "Legacy");
    assert.deepEqual(new TaskStore({ workspacePath: workspaceA }).getReviewSettings(), {
      automationMode: "human_gated",
      maxReworkRounds: 1,
      updatedAt: 2,
    });
    assert.equal(new TaskStore({ workspacePath: workspaceA }).listReviewActionAudits("legacy-task").length, 1);
    const after = fs.statSync(sourcePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });

  it("rejects an unsupported legacy schema without writing an audit row", () => {
    const workspacesDir = path.join(root, "unsupported-workspaces");
    const workspaceId = deriveWorkspaceStateId(workspaceA);
    const sourceDir = path.join(workspacesDir, workspaceId);
    const sourcePath = path.join(sourceDir, "ads.db");
    fs.mkdirSync(sourceDir, { recursive: true });

    process.env.ADS_DATABASE_PATH = sourcePath;
    resetDatabaseForTests();
    getDatabase().prepare("UPDATE schema_version SET version = 999 WHERE id = 1").run();
    resetDatabaseForTests();
    delete process.env.ADS_DATABASE_PATH;

    const central = getWorkspacesDatabase();
    assert.throws(
      () => migrateLegacyWorkspacesToCentralDb(central, { workspacesDir }),
      /Unsupported legacy schema version/,
    );
    assert.equal(
      central.prepare("SELECT COUNT(*) AS count FROM legacy_workspace_migrations WHERE source_path = ?").get(sourcePath)?.count,
      0,
    );
  });
});
