/**
 * Black-box scheduler runtime conformance for the Rust server. The Rust runtime
 * must materialize a due schedule, enqueue it, execute it, persist a terminal
 * run, and advance nextRunAt while leaving disabled schedules untouched.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, loginAs, startServerPair } from "./lib/black-box.mjs";

const Database = loadTsServerDependency("better-sqlite3");
const WebSocket = loadTsServerDependency("ws");

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

function scheduleSpec(prompt) {
  return {
    version: 1,
    name: "runtime-sample",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    instruction: "Run the scheduler conformance sample.",
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
      title: "Runtime sample",
      prompt,
      expectedResultSchema: { type: "object" },
      verification: { commands: [] },
    },
    questions: [],
  };
}

function telegramScheduleSpec(prompt, chatId) {
  const spec = scheduleSpec(prompt);
  spec.delivery.channels = ["telegram"];
  spec.delivery.telegram.chatId = chatId;
  return spec;
}

async function connectConnector(baseUrl, token) {
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(
    wsUrl,
    ["ads-v1", "ads-session.telegram", "ads-chat.main"],
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const events = [];
  const waiters = [];
  let welcomeResolve;
  let welcomeReject;
  const welcome = new Promise((resolve, reject) => {
    welcomeResolve = resolve;
    welcomeReject = reject;
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "welcome") welcomeResolve();
    if (frame.type !== "task_terminal") return;
    events.push(frame.event);
    for (const waiter of waiters.splice(0)) waiter(frame.event);
  });
  ws.once("error", (error) => welcomeReject(error));
  ws.once("close", (code, reason) =>
    welcomeReject(new Error(`connector websocket closed ${code}: ${String(reason)}`)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await welcome;
  return {
    ws,
    waitForEvent(timeoutMs = 15_000) {
      if (events.length) return Promise.resolve(events.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("task_terminal timeout")), timeoutMs);
        waiters.push((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      });
    },
  };
}

function seedSchedule(stateDir, id, workspace, spec, enabled, nextRunAt) {
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

function readSchedule(stateDir, id) {
  const db = new Database(path.join(stateDir, "workspaces.db"));
  try {
    return db.prepare("SELECT enabled, next_run_at FROM schedules WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

async function waitForRuns(pair, workspace, cookie, scheduleId = "sched-runtime-due", timeoutMs = 15_000) {
  const query = `?workspace=${encodeURIComponent(workspace)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await pair.rustRequest(
      `/api/schedules/${scheduleId}/runs${query}`,
      { headers: { cookie } },
    );
    assert(response.status === 200, `runs ${response.status}: ${JSON.stringify(response.body)}`);
    const runs = response.body?.runs ?? [];
    if (runs.length > 0 && ["failed", "completed"].includes(runs[0].status)) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const db = new Database(path.join(pair.rustStateDir, "workspaces.db"), { readonly: true });
  try {
    const schedule = db
      .prepare("SELECT id, enabled, next_run_at, lease_until FROM schedules WHERE id = ?")
      .get(scheduleId);
    const runs = db
      .prepare("SELECT external_id, status, error FROM schedule_runs WHERE schedule_id = ?")
      .all(scheduleId);
    throw new Error(
      `scheduler runtime did not finish a due run schedule=${JSON.stringify(schedule)} runs=${JSON.stringify(runs)}`,
    );
  } finally {
    db.close();
  }
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-scheduler-runtime-"));
  const pair = await startServerPair({
    root,
    rustDir,
    nodeCwd: root,
    rustCwd: workspace,
    env: {
      ALLOWED_DIRS: workspace,
      ADS_SCHEDULER_TICK_MS: "100",
      ADS_SCHEDULER_RUNNER_POLL_MS: "100",
      ADS_SCHEDULER_RUNNER_TIMEOUT_SECS: "2",
      ADS_SCHEDULER_LEASE_TTL_MS: "2000",
      ADS_CONNECTOR_TOKEN: "task-terminal-token",
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_API_BASE: "",
      CCHAT_OPENAI_API_KEY: "",
    },
  });
  try {
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const query = `?workspace=${encodeURIComponent(workspace)}`;
    const rustWarm = await pair.rustRequest(`/api/schedules${query}`, {
      headers: { cookie: rustLogin.cookie },
    });
    assert(
      rustWarm.status === 200,
      `rust warmup ${rustWarm.status}: ${JSON.stringify(rustWarm.body)}`,
    );

    const dueAt = Date.now() - 60_000;
    const connector = await connectConnector(pair.rustBase, "task-terminal-token");
    try {
      seedSchedule(
        pair.rustStateDir,
        "sched-runtime-telegram",
        workspace,
        telegramScheduleSpec("Return telegram conformance output.", "chat-conformance"),
        true,
        dueAt,
      );
      const telegramRuns = await waitForRuns(
        pair,
        workspace,
        rustLogin.cookie,
        "sched-runtime-telegram",
      );
      assert(
        telegramRuns[0]?.status === "failed",
        `telegram run status ${telegramRuns[0]?.status}`,
      );
      const terminal = await connector.waitForEvent();
      assert(terminal.taskId, "task_terminal must include taskId");
      assert(terminal.status === "failed", `telegram terminal status ${terminal.status}`);
      assert(terminal.workspaceRoot === workspace, "task_terminal workspace mismatch");
      assert(terminal.telegramChatId === "chat-conformance", "telegramChatId mismatch");
    } finally {
      connector.ws.close();
    }
    seedSchedule(
      pair.rustStateDir,
      "sched-runtime-due",
      workspace,
      scheduleSpec("Return scheduler conformance output."),
      true,
      dueAt,
    );
    seedSchedule(
      pair.rustStateDir,
      "sched-runtime-disabled",
      workspace,
      scheduleSpec("This schedule must not run."),
      false,
      dueAt,
    );

    const runs = await waitForRuns(pair, workspace, rustLogin.cookie);
    assert(runs.length === 1, `expected one run, got ${runs.length}`);
    const run = runs[0];
    assert(run.status === "failed", `expected failed run, got ${run.status}`);
    assert(
      typeof run.error === "string" && run.error.trim().length > 0,
      "failed run must persist an error summary",
    );
    assert(run.startedAt != null, "run must record startedAt");
    assert(run.completedAt != null, "run must record completedAt");

    const schedule = readSchedule(pair.rustStateDir, "sched-runtime-due");
    assert(schedule.enabled === 1, "due schedule must stay enabled");
    assert(
      schedule.next_run_at != null && schedule.next_run_at > dueAt,
      `next_run_at was not advanced: ${JSON.stringify(schedule)}`,
    );

    const disabled = await pair.rustRequest(
      `/api/schedules/sched-runtime-disabled/runs${query}`,
      { headers: { cookie: rustLogin.cookie } },
    );
    assert(disabled.status === 200, `disabled runs ${disabled.status}`);
    assert(
      (disabled.body?.runs ?? []).length === 0,
      `disabled schedule must not run: ${JSON.stringify(disabled.body)}`,
    );

    const queuePath = path.join(
      pair.rustStateDir,
      "workspaces",
      workspaceId(workspace),
      "ads.liteque.db",
    );
    assert(fs.existsSync(queuePath), `queue database missing at ${queuePath}`);
    const queue = new Database(queuePath, { readonly: true });
    try {
      const journal = queue
        .prepare("SELECT COUNT(1) AS count FROM __drizzle_migrations")
        .get();
      assert(Number(journal?.count) === 4, `drizzle journal rows ${journal?.count}`);
      const finished = queue
        .prepare("SELECT COUNT(1) AS count FROM tasks WHERE status = 'completed'")
        .get();
      assert(Number(finished?.count) === 0, "completed queue jobs must be deleted");
    } finally {
      queue.close();
    }

    console.log("scheduler runtime conformance: ok");
  } catch (error) {
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
