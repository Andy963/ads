import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import {
  createActionJob,
  getActionJobs,
  getActionJobById,
  updateActionJobStatus,
  deleteActionJobsByProject,
} from "../../server/state/actionJobStore.js";
import { deleteWebProject } from "../../server/web/projects/store.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";

describe("state/actionJobStore", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-action-job-test-"));
    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
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

  it("creates, queries, and updates action jobs", () => {
    const db = getStateDatabase();
    const job = createActionJob(db, {
      id: "job-100-277-abcd",
      project_id: "/home/andy/repos/ads",
      issue_id: 277,
      issue_title: "Acopilot & Actions refactor",
      issue_snapshot: {
        title: "Acopilot & Actions refactor",
        description: "Complete immutable contract",
        acceptanceCriteria: ["Reviewer is isolated"],
        adrs: [{ id: "ADR 0020", title: "Reviewer context", decision: "Use a fresh session" }],
      },
      status: "queued",
      branch: "codex/issue-277",
    });

    assert.strictEqual(job.id, "job-100-277-abcd");
    assert.strictEqual(job.status, "queued");
    assert.strictEqual(job.rework_count, 0);

    const retrieved = getActionJobById(db, "job-100-277-abcd");
    assert.ok(retrieved);
    assert.strictEqual(retrieved.issue_id, 277);
    assert.deepStrictEqual(JSON.parse(retrieved.issue_snapshot_json), {
      title: "Acopilot & Actions refactor",
      description: "Complete immutable contract",
      acceptanceCriteria: ["Reviewer is isolated"],
      adrs: [{ id: "ADR 0020", title: "Reviewer context", decision: "Use a fresh session" }],
    });

    updateActionJobStatus(db, "job-100-277-abcd", "running", {
      current_step: "Implementing schema migrations",
      rework_count: 1,
    });

    const updated = getActionJobById(db, "job-100-277-abcd");
    assert.ok(updated);
    assert.strictEqual(updated.status, "running");
    assert.strictEqual(updated.current_step, "Implementing schema migrations");
    assert.strictEqual(updated.rework_count, 1);

    const list = getActionJobs(db, "/home/andy/repos/ads");
    assert.strictEqual(list.length, 1);

    createActionJob(db, {
      id: "job-standalone-del",
      project_id: "/home/andy/repos/standalone",
      issue_title: "Standalone task",
    });
    const deleted = deleteActionJobsByProject(db, "/home/andy/repos/standalone");
    assert.strictEqual(deleted, 1);
  });

  it("cascade deletes action_jobs when project is deleted", () => {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    db.prepare("INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "u1",
      "user1",
      "hash",
      1,
      1,
    );
    db.prepare("INSERT OR IGNORE INTO web_projects (user_id, project_id, workspace_root, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "u1",
      "proj-to-delete",
      "/tmp/proj",
      "Test Project",
      1,
      1,
    );

    createActionJob(db, {
      id: "job-del-1",
      project_id: "proj-to-delete",
      issue_title: "Task 1",
    });

    assert.strictEqual(getActionJobs(db, "proj-to-delete").length, 1);

    deleteWebProject(db, "u1", "proj-to-delete");

    assert.strictEqual(getActionJobs(db, "proj-to-delete").length, 0);
  });
});
