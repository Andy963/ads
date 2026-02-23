import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { handleScheduleRoutes } from "../../src/web/server/api/routes/schedules.js";
import type { ScheduleSpec } from "../../src/scheduler/scheduleSpec.js";
import { SchedulerRuntime } from "../../src/scheduler/runtime.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createReq(method: string, body?: unknown): FakeReq {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) {
        yield payload;
      }
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

describe("web/api/schedules", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };
  const originalNow = Date.now;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-schedules-route-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    Date.now = originalNow;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates, lists, enables and disables schedules", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    Date.now = () => now;

    const workspaceRoot = tmpDir;
    const baseSpec: ScheduleSpec = {
      version: 1,
      name: "daily-sample",
      enabled: true,
      schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
      instruction: "Every day at 09:00 UTC, produce a sample report.",
      delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
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
      questions: [],
    };

    const compiler = {
      async compile({ instruction }: { instruction: string }) {
        return { ...baseSpec, instruction };
      },
    };

    const scheduler = new SchedulerRuntime({ enabled: false });

    const deps = {
      resolveWorkspaceRoot() {
        return workspaceRoot;
      },
      scheduleCompiler: compiler as any,
      scheduler,
    };

    const reqCreate = createReq("POST", { instruction: baseSpec.instruction });
    const resCreate = createRes();
    const createUrl = new URL(`http://localhost/api/schedules?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleScheduleRoutes(
        { req: reqCreate as any, res: resCreate as any, url: createUrl, pathname: "/api/schedules", auth: {} as any } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resCreate.statusCode, 201);
    const created = parseJson<{ schedule: { id: string; enabled: boolean; nextRunAt: number | null } }>(resCreate.body).schedule;
    assert.equal(created.enabled, true);
    assert.equal(created.nextRunAt, Date.UTC(2026, 0, 1, 9, 0, 0));

    const reqList = createReq("GET");
    const resList = createRes();
    assert.equal(
      await handleScheduleRoutes(
        { req: reqList as any, res: resList as any, url: createUrl, pathname: "/api/schedules", auth: {} as any } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resList.statusCode, 200);
    const schedules = parseJson<{ schedules: Array<{ id: string }> }>(resList.body).schedules;
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!.id, created.id);

    const reqDisable = createReq("POST");
    const resDisable = createRes();
    const disableUrl = new URL(
      `http://localhost/api/schedules/${encodeURIComponent(created.id)}/disable?workspace=${encodeURIComponent(workspaceRoot)}`,
    );
    assert.equal(
      await handleScheduleRoutes(
        {
          req: reqDisable as any,
          res: resDisable as any,
          url: disableUrl,
          pathname: `/api/schedules/${created.id}/disable`,
          auth: {} as any,
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resDisable.statusCode, 200);
    const disabled = parseJson<{ schedule: { enabled: boolean; nextRunAt: number | null } }>(resDisable.body).schedule;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);

    const reqEnable = createReq("POST");
    const resEnable = createRes();
    const enableUrl = new URL(
      `http://localhost/api/schedules/${encodeURIComponent(created.id)}/enable?workspace=${encodeURIComponent(workspaceRoot)}`,
    );
    assert.equal(
      await handleScheduleRoutes(
        {
          req: reqEnable as any,
          res: resEnable as any,
          url: enableUrl,
          pathname: `/api/schedules/${created.id}/enable`,
          auth: {} as any,
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resEnable.statusCode, 200);
    const enabled = parseJson<{ schedule: { enabled: boolean; nextRunAt: number | null } }>(resEnable.body).schedule;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, Date.UTC(2026, 0, 1, 9, 0, 0));

    const reqRuns = createReq("GET");
    const resRuns = createRes();
    const runsUrl = new URL(
      `http://localhost/api/schedules/${encodeURIComponent(created.id)}/runs?workspace=${encodeURIComponent(workspaceRoot)}`,
    );
    assert.equal(
      await handleScheduleRoutes(
        { req: reqRuns as any, res: resRuns as any, url: runsUrl, pathname: `/api/schedules/${created.id}/runs`, auth: {} as any } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resRuns.statusCode, 200);
    assert.deepEqual(parseJson<{ runs: unknown[] }>(resRuns.body).runs, []);
  });

  it("prevents enabling schedules with questions", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    Date.now = () => now;

    const workspaceRoot = tmpDir;
    const baseSpec: ScheduleSpec = {
      version: 1,
      name: "needs-timezone",
      enabled: false,
      schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
      instruction: "Every day at 09:00, do something.",
      delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
      policy: {
        workspaceWrite: false,
        network: "deny",
        maxDurationMs: 600000,
        maxRetries: 0,
        concurrencyKey: "schedule:{scheduleId}",
        idempotencyKeyTemplate: "sch:{scheduleId}:{runAtIso}",
      },
      compiledTask: {
        title: "Do something",
        prompt: "Return a single JSON object.",
        expectedResultSchema: { type: "object" },
        verification: { commands: [] },
      },
      questions: ["Which timezone should be used?"],
    };

    const compiler = {
      async compile({ instruction }: { instruction: string }) {
        return { ...baseSpec, instruction };
      },
    };

    const scheduler = new SchedulerRuntime({ enabled: false });

    const deps = {
      resolveWorkspaceRoot() {
        return workspaceRoot;
      },
      scheduleCompiler: compiler as any,
      scheduler,
    };

    const reqCreate = createReq("POST", { instruction: baseSpec.instruction });
    const resCreate = createRes();
    const createUrl = new URL(`http://localhost/api/schedules?workspace=${encodeURIComponent(workspaceRoot)}`);
    assert.equal(
      await handleScheduleRoutes(
        { req: reqCreate as any, res: resCreate as any, url: createUrl, pathname: "/api/schedules", auth: {} as any } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resCreate.statusCode, 201);
    const created = parseJson<{ schedule: { id: string; enabled: boolean } }>(resCreate.body).schedule;
    assert.equal(created.enabled, false);

    const reqEnable = createReq("POST");
    const resEnable = createRes();
    const enableUrl = new URL(
      `http://localhost/api/schedules/${encodeURIComponent(created.id)}/enable?workspace=${encodeURIComponent(workspaceRoot)}`,
    );
    assert.equal(
      await handleScheduleRoutes(
        {
          req: reqEnable as any,
          res: resEnable as any,
          url: enableUrl,
          pathname: `/api/schedules/${created.id}/enable`,
          auth: {} as any,
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(resEnable.statusCode, 409);
    const payload = parseJson<{ error: string; questions: string[] }>(resEnable.body);
    assert.equal(payload.questions.length, 1);
  });
});
