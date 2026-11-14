import { ScheduleStore } from "../../server/scheduler/store.js";

const [mode, dbPath, workspaceRoot] = process.argv.slice(2);
if (!mode || !dbPath || !workspaceRoot) {
  throw new Error("usage: workspace-schedule-fixture.ts <mode> <db-path> <workspace-root>");
}
process.env.ADS_DATABASE_PATH = dbPath;

function scheduleSpec(name: string) {
  return {
    version: 1 as const,
    name,
    enabled: true,
    schedule: { type: "cron" as const, cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    instruction: "summarize the inbox",
    delivery: {
      channels: ["web" as const],
      web: { audience: "owner" },
      telegram: { chatId: null },
    },
    policy: {
      workspaceWrite: false,
      network: "deny" as const,
      maxDurationMs: 60_000,
      maxRetries: 1,
      concurrencyKey: "inbox",
      idempotencyKeyTemplate: "inbox-{runAt}",
    },
    compiledTask: {
      title: "Inbox summary",
      prompt: "Summarize the inbox",
      expectedResultSchema: { type: "object" },
      verification: { commands: ["true"] },
    },
    questions: [],
  };
}

const store = new ScheduleStore({ workspacePath: workspaceRoot });

if (mode === "verify") {
  const schedules = store.listSchedules();
  const runsByScheduleId = Object.fromEntries(
    schedules.map((schedule) => [schedule.id, store.listRuns(schedule.id)]),
  );
  process.stdout.write(`${JSON.stringify({ schedules, runsByScheduleId })}\n`);
} else if (mode === "write") {
  const schedule = store.createSchedule(
    {
      instruction: "typescript instruction",
      spec: scheduleSpec("TypeScript schedule"),
      enabled: true,
      nextRunAt: 500,
    },
    400,
  );
  const run = store.insertRun(
    {
      scheduleId: schedule.id,
      externalId: "ts-external-1",
      runAt: 500,
      taskId: null,
      status: "running",
    },
    410,
  );
  const updated = store.updateRunByExternalId(
    "ts-external-1",
    { status: "completed", result: "ts result", completedAt: 420 },
    420,
  );
  process.stdout.write(`${JSON.stringify({ schedule, run, updated })}\n`);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
