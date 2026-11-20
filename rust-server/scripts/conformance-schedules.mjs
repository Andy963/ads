/**
 * Black-box schedule route conformance: seed the same workspace schedule rows
 * into the isolated Node and Rust databases, then compare list/enable/disable/
 * runs responses.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { assert, compare, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");

function workspaceId(workspaceRoot) {
  const resolved = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const slug = (path.basename(resolved) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 48);
  return `${slug}-${hash}`;
}

function scheduleSpec(questions = []) {
  return {
    version: 1,
    name: "daily-sample",
    enabled: false,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    instruction: "Every day at 09:00 UTC, produce a sample report.",
    delivery: {
      channels: ["web"],
      web: { audience: "owner" },
      telegram: { chatId: null },
    },
    policy: {
      workspaceWrite: false,
      network: "deny",
      maxDurationMs: 600000,
      maxRetries: 0,
      concurrencyKey: "schedule:{scheduleId}",
      idempotencyKeyTemplate: "sch:{scheduleId}:{runAtIso}",
    },
    compiledTask: {
      title: "Produce a sample report",
      prompt: "Return a single JSON object.",
      expectedResultSchema: { type: "object" },
      verification: { commands: [] },
    },
    questions,
  };
}

function seedSchedule(stateDir, id, workspace, spec, enabled = false, nextRunAt = null) {
  const db = new Database(path.join(stateDir, "workspaces.db"));
  try {
    db.prepare(
      `INSERT INTO schedules (
         workspace_id, id, instruction, spec_json, enabled, next_run_at,
         lease_owner, lease_until, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      workspaceId(workspace),
      id,
      spec.instruction,
      JSON.stringify(spec),
      enabled ? 1 : 0,
      nextRunAt,
      1_700_000_000_000,
      1_700_000_000_000,
    );
  } finally {
    db.close();
  }
}

function workspaceQuery(workspace) {
  return `?workspace=${encodeURIComponent(workspace)}`;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-schedule-conformance-"));
  const pair = await startServerPair({
    root,
    rustDir,
    nodeCwd: root,
    rustCwd: workspace,
    env: {
      ALLOWED_DIRS: workspace,
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_API_BASE: "",
      CCHAT_OPENAI_API_KEY: "",
    },
  });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const query = workspaceQuery(workspace);
    const nodeWarm = await pair.nodeRequest(`/api/schedules${query}`, {
      headers: { cookie: nodeLogin.cookie },
    });
    const rustWarm = await pair.rustRequest(`/api/schedules${query}`, {
      headers: { cookie: rustLogin.cookie },
    });
    assert(nodeWarm.status === 200, `node warmup ${nodeWarm.status}: ${JSON.stringify(nodeWarm.body)}`);
    assert(rustWarm.status === 200, `rust warmup ${rustWarm.status}: ${JSON.stringify(rustWarm.body)}`);
    const spec = scheduleSpec();
    seedSchedule(pair.nodeStateDir, "sched-conformance-1", workspace, spec);
    seedSchedule(pair.rustStateDir, "sched-conformance-1", workspace, spec);
    const questionSpec = scheduleSpec([
      "Which Telegram chatId should receive the schedule result?",
    ]);
    seedSchedule(pair.nodeStateDir, "sched-conformance-questions", workspace, questionSpec);
    seedSchedule(pair.rustStateDir, "sched-conformance-questions", workspace, questionSpec);

    const list = await pair.nodeRequest(`/api/schedules${query}`, {
      headers: { cookie: nodeLogin.cookie },
    });
    const rustList = await pair.rustRequest(`/api/schedules${query}`, {
      headers: { cookie: rustLogin.cookie },
    });
    await compare("schedules list", list, rustList, {});
    assert(list.status === 200, `list status ${list.status}: ${JSON.stringify(list.body)}`);
    assert(list.body.schedules.length === 2, `seeded schedules ${list.body.schedules.length}`);

    const nodeRequest = (pathname) => pair.nodeRequest(pathname, {
      method: "POST",
      headers: { cookie: nodeLogin.cookie },
    });
    const rustRequest = (pathname) => pair.rustRequest(pathname, {
      method: "POST",
      headers: { cookie: rustLogin.cookie },
    });

    const disablePath = `/api/schedules/sched-conformance-1/disable${query}`;
    await compare(
      "schedules disable",
      await nodeRequest(disablePath),
      await rustRequest(disablePath),
      { masks: ["schedule.updatedAt"] },
    );

    const enablePath = `/api/schedules/sched-conformance-1/enable${query}`;
    await compare(
      "schedules enable",
      await nodeRequest(enablePath),
      await rustRequest(enablePath),
      { masks: ["schedule.updatedAt"] },
    );

    const questionEnablePath = `/api/schedules/sched-conformance-questions/enable${query}`;
    await compare(
      "schedules enable with questions",
      await nodeRequest(questionEnablePath),
      await rustRequest(questionEnablePath),
    );

    const runsPath = `/api/schedules/sched-conformance-1/runs${query}`;
    await compare(
      "schedules runs",
      await pair.nodeRequest(runsPath, { headers: { cookie: nodeLogin.cookie } }),
      await pair.rustRequest(runsPath, { headers: { cookie: rustLogin.cookie } }),
    );
    console.log("schedules conformance: ok");
  } catch (error) {
    console.error("--- node output ---\n" + pair.nodeOutput());
    console.error("--- rust output ---\n" + pair.rustOutput());
    throw error;
  } finally {
    await pair.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
