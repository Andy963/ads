import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { it } from "node:test";

import { stateSchemaMigrations } from "../../server/state/schemaMigrations.js";

it("consolidates role profiles without losing retired Developer settings", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE role_profiles (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('acopilot', 'developer', 'reviewer')),
        name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        system_prompt TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_role_profiles_role ON role_profiles(role, is_enabled);
      CREATE UNIQUE INDEX idx_role_profile_single ON role_profiles(role);
      CREATE TABLE action_jobs (
        status TEXT NOT NULL,
        current_step TEXT,
        error_message TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    const insert = db.prepare(`
      INSERT INTO role_profiles
        (id, role, name, model_id, reasoning_effort, system_prompt, is_enabled, is_default, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, 4, ?)
    `);
    insert.run(
      "profile-acopilot",
      "acopilot",
      "Custom Acopilot",
      "model-acopilot",
      "max",
      [
        "You are the ADS Acopilot.",
        "",
        "## Role & Boundary",
        "- Your job is technical investigation, architectural planning, and GitHub collaboration records.",
        "- You operate strictly in a read-only analysis role. Do NOT modify source code or implement fixes directly; hand implementation work to the Developer.",
        "- Do not commit, push, merge, deploy, or delete project assets without explicit user authorization.",
        "- Use Simplified Chinese for discussions; use English for GitHub Issues and ADRs.",
        "- When investigating problems or authoring GitHub Issues, follow the `acopilot-issue-flow` skill.",
        "",
        "## 决策与调研原则",
        "- 审查、审计、解释和方案均视为只读；计划与提案不构成实施授权。",
        "",
        "## 写作指令",
        "- 你写的每一句话必须经得起两个检验。",
      ].join("\n"),
      100,
    );
    insert.run("profile-developer", "developer", "Custom Developer", "model-developer", "low", "Developer customization", 200);
    insert.run("profile-reviewer", "reviewer", "Custom Reviewer", "model-reviewer", "high", "Reviewer customization", 300);
    db.prepare("INSERT INTO action_jobs (status, current_step, error_message, updated_at) VALUES (?, '', '', 1)").run("queued");
    db.prepare("INSERT INTO action_jobs (status, current_step, error_message, updated_at) VALUES (?, '', '', 1)").run("completed");

    const migration = stateSchemaMigrations.find((entry) => entry.version === 38);
    assert.ok(migration);
    migration.up(db);

    const profiles = db.prepare("SELECT role, model_id, reasoning_effort, system_prompt FROM role_profiles ORDER BY role").all() as Array<{
      role: string;
      model_id: string;
      reasoning_effort: string;
      system_prompt: string;
    }>;
    assert.deepEqual(profiles.map((profile) => profile.role), ["acopilot", "reviewer"]);
    assert.equal(profiles[0]?.model_id, "model-acopilot");
    assert.equal(profiles[0]?.reasoning_effort, "max");
    const acopilotPrompt = profiles[0]?.system_prompt ?? "";
    assert.match(acopilotPrompt, /审查、审计、解释和方案均视为只读/);
    assert.match(acopilotPrompt, /你写的每一句话必须经得起两个检验/);
    assert.doesNotMatch(acopilotPrompt, /## Role & Boundary/);
    assert.doesNotMatch(acopilotPrompt, /read-only analysis role/);
    assert.doesNotMatch(acopilotPrompt, /hand implementation work to the Developer/);
    assert.match(acopilotPrompt, /Follow acopilot-issue-flow for evidence and Issue authoring, and developer-pr-lifecycle for implementation/);
    assert.match(acopilotPrompt, /owner of the full implementation lifecycle/);
    assert.match(acopilotPrompt, /begin_implementation/);
    assert.match(acopilotPrompt, /review_action/);
    assert.match(acopilotPrompt, /Where this section conflicts with an earlier line in this prompt, this section wins\./);
    assert.equal(profiles[1]?.model_id, "model-reviewer");
    assert.match(profiles[1]?.system_prompt ?? "", /Do not implement fixes or modify files/);

    const archived = db.prepare("SELECT profile_json FROM legacy_role_profile_archive WHERE profile_id = ?").get("profile-developer") as { profile_json: string };
    const archivedProfile = JSON.parse(archived.profile_json) as { model_id: string; reasoning_effort: string };
    assert.equal(archivedProfile.model_id, "model-developer");
    assert.equal(archivedProfile.reasoning_effort, "low");

    const jobs = db.prepare("SELECT status FROM action_jobs ORDER BY rowid").all() as Array<{ status: string }>;
    assert.deepEqual(jobs.map((job) => job.status), ["cancelled", "completed"]);
    assert.throws(() => db.prepare(`
      INSERT INTO role_profiles (id, role, name, model_id, system_prompt, updated_at)
      VALUES ('retired', 'developer', 'Developer', '', '', 0)
    `).run(), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

it("restores Reviewer jobs without dropping historical Actions job data", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE action_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        lane_generation INTEGER NOT NULL DEFAULT 1,
        job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt')),
        issue_id INTEGER,
        issue_title TEXT NOT NULL,
        issue_snapshot_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'blocked', 'cancelled'
        )),
        branch TEXT,
        base_sha TEXT,
        head_sha TEXT,
        developer_profile_id TEXT,
        reviewer_profile_ids_json TEXT NOT NULL DEFAULT '[]',
        current_step TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        review_verdicts_json TEXT NOT NULL DEFAULT '[]',
        attempts_json TEXT NOT NULL DEFAULT '[]',
        pr_number INTEGER,
        pr_url TEXT,
        error_message TEXT,
        rework_count INTEGER NOT NULL DEFAULT 0,
        blocked_at INTEGER,
        auth_user_id TEXT,
        chat_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_action_jobs_lookup ON action_jobs(project_id, status, created_at);
      INSERT INTO action_jobs (id, project_id, issue_title, status, head_sha, auth_user_id, created_at, updated_at)
      VALUES ('legacy', 'project-1', 'Legacy task', 'completed', 'old-head', 'user-1', 1, 2);
    `);

    const migration = stateSchemaMigrations.find((entry) => entry.version === 39);
    assert.ok(migration);
    migration.up(db);

    const legacy = db.prepare("SELECT * FROM action_jobs WHERE id = 'legacy'").get() as Record<string, unknown>;
    assert.equal(legacy.head_sha, "old-head");
    assert.equal(legacy.auth_user_id, "user-1");
    assert.equal(legacy.status, "completed");
    db.prepare(`
      INSERT INTO action_jobs (id, project_id, job_kind, issue_title, status, created_at, updated_at)
      VALUES ('review', 'project-1', 'pull_request_review', 'Review', 'queued', 3, 3)
    `).run();
    assert.equal(
      (db.prepare("SELECT job_kind FROM action_jobs WHERE id = 'review'").get() as { job_kind: string }).job_kind,
      "pull_request_review",
    );
  } finally {
    db.close();
  }
});
