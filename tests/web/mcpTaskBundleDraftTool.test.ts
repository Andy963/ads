import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests, getStateDatabase } from "../../src/state/database.js";
import { createMcpBearerToken, verifyMcpBearerToken } from "../../src/web/server/mcp/auth.js";
import { createMcpRouter } from "../../src/web/server/mcp/router.js";
import { taskBundleDraftUpsertTool } from "../../src/web/server/mcp/tools/taskBundleDraftTool.js";

describe("web/server/mcp task bundle draft tool", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-mcp-"));
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

  it("tools/list exposes the draft tool", async () => {
    const router = createMcpRouter([taskBundleDraftUpsertTool]);
    const ctx = {
      auth: {
        version: 1,
        authUserId: "u1",
        sessionId: "s1",
        chatSessionId: "planner",
        historyKey: "h1",
        workspaceRoot: "/tmp/ws",
        issuedAtMs: 1700000000000,
        expiresAtMs: 1700000300000,
      },
      req: {} as never,
      broadcastPlanner: () => undefined,
    };

    const response = await router.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    assert.ok(response);
    assert.ok(!Array.isArray(response));
    assert.ok("result" in response);
    const tools = (response.result as { tools?: unknown[] }).tools;
    assert.ok(Array.isArray(tools));
    assert.ok(tools.some((t) => (t as { name?: unknown }).name === "ads_task_bundle_draft_upsert"));
  });

  it("tools/call upserts a task bundle draft", async () => {
    const pepper = "pepper";
    const token = createMcpBearerToken({
      pepper,
      nowMs: 1700000000000,
      ttlMs: 60_000,
      context: {
        authUserId: "u1",
        sessionId: "s1",
        chatSessionId: "planner",
        historyKey: "h1",
        workspaceRoot: "/tmp/ws",
        requestId: "req-1",
        clientMessageId: "cmid-1",
      },
    });
    const verified = verifyMcpBearerToken({ token, pepper, nowMs: 1700000001000 });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;

    let broadcasted = 0;
    const router = createMcpRouter([taskBundleDraftUpsertTool]);
    const ctx = {
      auth: verified.context,
      req: {} as never,
      broadcastPlanner: () => {
        broadcasted += 1;
      },
    };

    const response = await router.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ads_task_bundle_draft_upsert",
          arguments: {
            bundle: {
              version: 1,
              tasks: [{ prompt: "do something" }],
            },
          },
        },
      },
      ctx,
    );

    assert.ok(response);
    assert.ok(!Array.isArray(response));
    assert.ok("result" in response);
    assert.ok(broadcasted >= 1);

    const db = getStateDatabase(process.env.ADS_STATE_DB_PATH);
    const row = db.prepare("SELECT draft_id, request_id, bundle_json FROM web_task_bundle_drafts").get() as {
      draft_id: string;
      request_id: string;
      bundle_json: string;
    };
    assert.ok(row.draft_id);
    assert.equal(row.request_id, "cmid:cmid-1");
    const firstBundle = JSON.parse(row.bundle_json) as { requestId?: string; tasks?: Array<{ externalId?: string; prompt?: string }> };
    assert.equal(firstBundle.requestId, "cmid:cmid-1");
    assert.equal(firstBundle.tasks?.[0]?.externalId, "tb:cmid:cmid-1:t:1");
    assert.equal(firstBundle.tasks?.[0]?.prompt, "do something");

    const retryResponse = await router.handle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ads_task_bundle_draft_upsert",
          arguments: {
            bundle: {
              version: 1,
              tasks: [{ prompt: "do something again" }],
            },
          },
        },
      },
      ctx,
    );
    assert.ok(retryResponse);

    const count = db.prepare("SELECT COUNT(*) AS c FROM web_task_bundle_drafts").get() as { c: number };
    assert.equal(count.c, 1);

    const reread = db.prepare("SELECT draft_id, request_id, bundle_json FROM web_task_bundle_drafts").get() as {
      draft_id: string;
      request_id: string;
      bundle_json: string;
    };
    assert.equal(reread.draft_id, row.draft_id);
    assert.equal(reread.request_id, "cmid:cmid-1");
    const secondBundle = JSON.parse(reread.bundle_json) as { tasks?: Array<{ prompt?: string }> };
    assert.equal(secondBundle.tasks?.[0]?.prompt, "do something again");
  });
});
