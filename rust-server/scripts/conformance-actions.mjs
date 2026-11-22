#!/usr/bin/env node
/**
 * Black-box Actions API conformance: seed identical completed review jobs in
 * both state databases, then compare project resolution, public fields, and
 * retired mutation responses.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, compare, loginAs, startServerPair } from "./lib/black-box.mjs";

const Database = loadTsServerDependency("better-sqlite3");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-conformance-"));
const projectDir = path.join(workspaceDir, "project");

function seedCompletedReview(stateDir, projectId, _workspaceRoot) {
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const user = db.prepare("SELECT id FROM web_users ORDER BY created_at ASC LIMIT 1").get();
    assert(user?.id, "missing initialized user");
    db.prepare(`
      INSERT INTO action_jobs (
        id, project_id, lane_generation, job_kind, issue_id, issue_title,
        issue_snapshot_json, verification_report_json, status, branch, base_sha,
        head_sha, reviewer_profile_ids_json, current_step, steps_json,
        review_verdicts_json, attempts_json, pr_number, pr_url, error_message,
        rework_count, blocked_at, auth_user_id, chat_session_id, created_at,
        updated_at, superseded_at, superseded_by_job_id
      ) VALUES (
        'job-1', ?, 2, 'pull_request_review', 7, 'Fix the bug',
        '{"title":"Fix the bug","description":"Fix it","acceptanceCriteria":["Criterion"],"adrs":[]}',
        '', 'completed', 'codex/issue-7', 'base-sha', 'head-sha', '[]',
        'PASS: All good', '[]', '[{"status":"PASS","summary":"All good","defects":[],"reviewedAt":1700000000000}]',
        '[]', 12, 'https://example.test/pr/12', NULL, 0, NULL, ?, 'main',
        1700000000000, 1700000000000, NULL, NULL
      )
    `).run(projectId, user.id);
  } finally {
    db.close();
  }
}

const RUST_HANDOFF_FIELDS = [
  "requires_agent_handoff",
  "acopilot_lane_generation",
  "agent_handoff_ready",
];

function omitRustHandoffFields(value) {
  if (Array.isArray(value)) {
    return value.map(omitRustHandoffFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RUST_HANDOFF_FIELDS.includes(key))
      .map(([key, child]) => [key, omitRustHandoffFields(child)]),
  );
}

async function main() {
  fs.mkdirSync(projectDir, { recursive: true });
  const pair = await startServerPair({
    root,
    rustDir,
    env: { ALLOWED_DIRS: workspaceDir },
  });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, "admin", "secret");
    const rustLogin = await loginAs(pair.rustBase, "admin", "secret");
    const nodeHeaders = { cookie: nodeLogin.cookie };
    const rustHeaders = { cookie: rustLogin.cookie };
    const jsonRequest = (body) => ({
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const rustJsonRequest = (body) => ({
      method: "POST",
      headers: { ...rustHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const nodeProject = await pair.nodeRequest(
      "/api/projects",
      jsonRequest({ path: projectDir }),
    );
    const rustProject = await pair.rustRequest(
      "/api/projects",
      rustJsonRequest({ path: projectDir }),
    );
    assert(nodeProject.status === 200, `node project create failed: ${nodeProject.status}`);
    assert(rustProject.status === 200, `rust project create failed: ${rustProject.status}`);
    const projectId = nodeProject.body.project.id;
    assert(projectId === rustProject.body.project.id, "project ids differ");

    seedCompletedReview(pair.nodeStateDir, projectId, projectDir);
    seedCompletedReview(pair.rustStateDir, projectId, projectDir);

    const withNode = (options = {}) => ({
      ...options,
      headers: { ...nodeHeaders, ...(options.headers ?? {}) },
    });
    const withRust = (options = {}) => ({
      ...options,
      headers: { ...rustHeaders, ...(options.headers ?? {}) },
    });
    async function compareBoth(label, pathname, options = {}) {
      const nodeResult = await pair.nodeRequest(pathname, withNode(options));
      const rustResult = await pair.rustRequest(pathname, withRust(options));
      rustResult.body = omitRustHandoffFields(rustResult.body);
      await compare(
        label,
        nodeResult,
        rustResult,
      );
    }

    await compareBoth(
      "actions-jobs-by-id",
      `/api/actions/jobs?projectId=${encodeURIComponent(projectId)}`,
    );
    await compareBoth(
      "actions-jobs-by-workspace",
      `/api/actions/jobs?workspace=${encodeURIComponent(projectDir)}`,
    );
    await compareBoth("actions-jobs-invalid", "/api/actions/jobs?projectId=missing");
    await compareBoth("actions-dispatch-retired", "/api/actions/dispatch", { method: "POST" });
    await compareBoth("actions-queue-retired", "/api/actions/queue/start", { method: "POST" });
    await compareBoth("actions-job-retired", "/api/actions/jobs/job-1", { method: "POST" });

    console.log("actions conformance: ok");
  } finally {
    await pair.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

await main();
