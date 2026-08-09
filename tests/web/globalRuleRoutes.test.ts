import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createGlobalRuleService } from "../../server/rules/globalRuleService.js";
import { createGlobalRuleStore, type GlobalRuleStore } from "../../server/state/globalRuleStore.js";
import { handleGlobalRuleRoutes } from "../../server/web/server/api/routes/globalRules.js";
import type { GlobalRule } from "../../server/state/globalRuleStore.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
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

function createRes() {
  return {
    statusCode: null as number | null,
    headers: {} as Record<string, string>,
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

describe("web/global-rules routes", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let store: GlobalRuleStore;
  let service: ReturnType<typeof createGlobalRuleService>;

  const call = async (method: string, pathname: string, body?: unknown, search = "") => {
    const res = createRes();
    const handled = await handleGlobalRuleRoutes(
      {
        req: createReq(method, body) as never,
        res: res as never,
        url: new URL(`http://localhost${pathname}${search}`),
        pathname,
        auth: { userId: "u-1", username: "andy" },
      } as never,
      { service },
    );
    return { handled, res };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-global-rule-routes-"));
    db = new DatabaseConstructor(path.join(tmpDir, "state.db"));
    store = createGlobalRuleStore(db);
    // Point at a missing bootstrap file so seeding stays a no-op for these tests.
    service = createGlobalRuleService({ db, templateRulesPath: path.join(tmpDir, "missing.md") });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates, lists, patches and deletes a rule with the caller as actor", async () => {
    const created = await call("POST", "/api/global-rules", {
      title: "进程自保",
      body: "禁止 pkill",
      category: "execution",
      severity: "blocked",
      priority: 10,
      match: { tools: ["shell"], commandPatterns: ["\\bpkill\\b"] },
    });
    assert.equal(created.handled, true);
    assert.equal(created.res.statusCode, 200);
    const rule = JSON.parse(created.res.body) as GlobalRule;
    assert.match(rule.id, /^rule-[0-9a-f-]+$/);
    assert.equal(rule.updatedBy, "andy");

    const listed = await call("GET", "/api/global-rules");
    assert.equal((JSON.parse(listed.res.body) as { rules: GlobalRule[] }).rules.length, 1);

    const patched = await call("PATCH", `/api/global-rules/${rule.id}`, { enabled: false });
    assert.equal((JSON.parse(patched.res.body) as GlobalRule).enabled, false);
    // Unspecified fields survive a partial update.
    assert.equal((JSON.parse(patched.res.body) as GlobalRule).severity, "blocked");

    const audit = await call("GET", "/api/global-rules/audit", undefined, "?limit=10");
    const actions = (JSON.parse(audit.res.body) as { entries: Array<{ action: string }> }).entries.map(
      (entry) => entry.action,
    );
    assert.deepEqual(actions, ["disable", "create"]);

    const removed = await call("DELETE", `/api/global-rules/${rule.id}`);
    assert.equal(removed.res.statusCode, 200);
    assert.equal(store.listRules().length, 0);
  });

  it("rejects a rule whose pattern is not a valid regular expression", async () => {
    const created = await call("POST", "/api/global-rules", {
      title: "坏正则",
      body: "bad",
      match: { commandPatterns: ["([unclosed"] },
    });
    assert.equal(created.res.statusCode, 400);
    assert.match(JSON.parse(created.res.body).error, /Invalid regular expression/);
  });

  it("returns 404 for an unknown rule id", async () => {
    const patched = await call("PATCH", "/api/global-rules/rule-missing", { enabled: true });
    assert.equal(patched.res.statusCode, 404);
    const removed = await call("DELETE", "/api/global-rules/rule-missing");
    assert.equal(removed.res.statusCode, 404);
  });

  it("previews the exact block that gets injected", async () => {
    store.saveRule({ id: "rule-a", title: "A", body: "first" });
    service.invalidate();
    const preview = await call("GET", "/api/global-rules/preview");
    const payload = JSON.parse(preview.res.body) as { text: string; source: string; ruleCount: number };
    assert.equal(payload.source, "database");
    assert.equal(payload.ruleCount, 1);
    assert.match(payload.text, /<global_rules>/);
  });

  it("evaluates the test panel in enforce semantics even while the runtime observes", async () => {
    store.saveRule({
      id: "rule-kill",
      title: "进程自保",
      body: "禁止 pkill",
      severity: "blocked",
      match: { tools: ["shell"], commandPatterns: ["\\bpkill\\b"] },
    });
    service.invalidate();
    const result = await call("POST", "/api/global-rules/test", {
      agent: "codex",
      channel: "web",
      tool: "shell",
      command: "pkill -f node",
    });
    const payload = JSON.parse(result.res.body) as { decision: string; hits: Array<{ ruleId: string }> };
    assert.equal(payload.decision, "deny");
    assert.equal(payload.hits[0].ruleId, "rule-kill");
  });

  it("ignores unrelated paths", async () => {
    const other = await call("GET", "/api/models");
    assert.equal(other.handled, false);
  });
});
