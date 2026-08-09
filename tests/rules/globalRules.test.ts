import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createGlobalRuleStore, type GlobalRuleStore } from "../../server/state/globalRuleStore.js";
import {
  createGlobalRuleService,
  renderGlobalRulesBlock,
  parseTemplateRules,
} from "../../server/rules/globalRuleService.js";
import { createRuleEnforcementGate } from "../../server/rules/enforcementGate.js";

const TEMPLATE_FIXTURE = [
  "# ADS 默认工作空间规则",
  "## rules:",
  "1. 数据库文件保护：未经明确许可，禁止删除或覆盖任何数据库文件。",
  "2. 提交策略：除非用户明确要求，否则不得执行 `git commit`、`git push` 等提交操作。",
  "3. 文档位置：所有新增文档必须位于 docs/ 目录内。",
  "10. 进程自保：禁止 `pkill`、`killall` 等按模式清理进程的方式。",
  "- 违反任一条即停止",
].join("\n");

describe("global rules store + service", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let store: GlobalRuleStore;
  let templatePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-global-rules-"));
    db = new DatabaseConstructor(path.join(tmpDir, "state.db"));
    store = createGlobalRuleStore(db);
    templatePath = path.join(tmpDir, "rules.md");
    fs.writeFileSync(templatePath, TEMPLATE_FIXTURE, "utf-8");
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("parses numbered template rules into title/body pairs", () => {
    const parsed = parseTemplateRules(TEMPLATE_FIXTURE);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].title, "数据库文件保护");
    assert.match(parsed[3].body, /进程自保/);
  });

  it("writes an audit entry for every mutation and keeps the before image", () => {
    const created = store.saveRule({
      id: "rule-1",
      title: "禁止删库",
      body: "禁止删除数据库文件",
      category: "safety",
      severity: "blocked",
      updatedBy: "andy",
    });
    assert.equal(created.severity, "blocked");
    assert.equal(created.enabled, true);

    store.saveRule({ id: "rule-1", title: created.title, body: created.body, enabled: false, updatedBy: "andy" });
    store.deleteRule("rule-1", "andy");

    const audit = store.listAudit({ ruleId: "rule-1" });
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ["delete", "disable", "create"],
    );
    assert.equal(audit[0].before?.title, "禁止删库");
    assert.equal(audit[0].after, null);
    assert.equal(store.getRule("rule-1"), null);
  });

  it("seeds from the template exactly once and marks enforceable rules", () => {
    const service = createGlobalRuleService({ db, templateRulesPath: templatePath });
    const seeded = service.seedIfNeeded();
    assert.equal(seeded, 5); // 4 template rules + 1 deployment rule
    assert.equal(service.seedIfNeeded(), 0);

    const rules = store.listRules();
    const selfProtection = rules.find((rule) => rule.title === "进程自保");
    assert.ok(selfProtection);
    assert.equal(selfProtection?.severity, "blocked");
    assert.ok(selfProtection?.match?.commandPatterns?.length);

    const docRule = rules.find((rule) => rule.title === "文档位置");
    assert.equal(docRule?.severity, "required");
    assert.equal(docRule?.match, null);
  });

  it("renders a stable <global_rules> block ordered by priority", () => {
    store.saveRule({ id: "rule-b", title: "B", body: "second", priority: 200 });
    store.saveRule({ id: "rule-a", title: "A", body: "first", priority: 100 });
    const text = renderGlobalRulesBlock(store.listEnabledRules());
    assert.ok(text.startsWith("<global_rules>"));
    assert.ok(text.trimEnd().endsWith("</global_rules>"));
    assert.ok(text.indexOf("first") < text.indexOf("second"));
  });

  it("invalidates the render cache when a rule changes", () => {
    const service = createGlobalRuleService({ db, templateRulesPath: templatePath });
    store.saveRule({ id: "rule-a", title: "A", body: "first" });
    const before = service.render();
    assert.equal(before.source, "database");
    assert.equal(before.ruleCount, 1);

    store.saveRule({ id: "rule-b", title: "B", body: "second" });
    const after = service.render();
    assert.equal(after.ruleCount, 2);
    assert.notEqual(after.hash, before.hash);
  });

  it("degrades to the read-only bootstrap file when the database is unusable", () => {
    const brokenDb = {
      exec() {
        throw new Error("database is locked");
      },
      prepare() {
        throw new Error("database is locked");
      },
    } as unknown as DatabaseType;
    const service = createGlobalRuleService({ db: brokenDb, templateRulesPath: templatePath });
    const rendered = service.render();
    assert.equal(rendered.degraded, true);
    assert.equal(rendered.source, "bootstrap");
    assert.match(rendered.text, /进程自保/);
  });

  it("skips disabled rules in both injection and evaluation", () => {
    const service = createGlobalRuleService({ db, templateRulesPath: templatePath });
    store.saveRule({
      id: "rule-kill",
      title: "进程自保",
      body: "禁止 pkill",
      severity: "blocked",
      enabled: false,
      match: { tools: ["shell"], commandPatterns: ["\\bpkill\\b"] },
    });
    service.invalidate();
    assert.equal(service.render().ruleCount, 0);

    const gate = createRuleEnforcementGate({ service, mode: "enforce" });
    const result = gate.evaluate({
      agent: "codex",
      channel: "web",
      workspace: "/tmp",
      tool: "shell",
      command: "pkill -f node",
      userExplicitlyApproved: false,
    });
    assert.equal(result.decision, "allow");
    assert.equal(result.hits.length, 0);
  });
});

describe("rule enforcement gate", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let store: GlobalRuleStore;
  let service: ReturnType<typeof createGlobalRuleService>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rule-gate-"));
    db = new DatabaseConstructor(path.join(tmpDir, "state.db"));
    store = createGlobalRuleStore(db);
    service = createGlobalRuleService({ db, templateRulesPath: path.join(tmpDir, "missing.md") });
    store.saveRule({
      id: "rule-kill",
      title: "进程自保",
      body: "禁止 pkill / killall",
      category: "execution",
      severity: "blocked",
      priority: 10,
      match: { tools: ["shell"], commandPatterns: ["\\b(pkill|killall)\\b"] },
    });
    store.saveRule({
      id: "rule-deploy",
      title: "部署需显式授权",
      body: "部署必须先获得授权",
      category: "execution",
      severity: "approval_required",
      priority: 20,
      match: { tools: ["shell"], commandPatterns: ["npm\\s+run\\s+deploy"] },
    });
    store.saveRule({
      id: "rule-prose",
      title: "文档位置",
      body: "文档必须放在 docs/",
      category: "instruction",
      severity: "required",
      priority: 30,
      match: null,
    });
    service.invalidate();
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const evaluate = (command: string, overrides: Record<string, unknown> = {}) =>
    createRuleEnforcementGate({ service, mode: "enforce" }).evaluate({
      agent: "codex",
      channel: "web",
      workspace: "/tmp",
      tool: "shell",
      command,
      userExplicitlyApproved: false,
      ...overrides,
    } as Parameters<ReturnType<typeof createRuleEnforcementGate>["evaluate"]>[0]);

  it("denies blocked commands regardless of user approval", () => {
    const result = evaluate("pkill -f cli.js", { userExplicitlyApproved: true });
    assert.equal(result.decision, "deny");
    assert.equal(result.effectiveDecision, "deny");
    assert.equal(result.hits[0].ruleId, "rule-kill");
  });

  it("catches a blocked command wrapped in a compound shell invocation", () => {
    const result = evaluate("bash -lc 'ps aux | grep node && pkill -f ads'");
    assert.equal(result.decision, "deny");
  });

  it("requires approval for deployment and clears it once approved", () => {
    assert.equal(evaluate("npm run deploy:local").decision, "require_approval");
    assert.equal(evaluate("npm run deploy:local", { userExplicitlyApproved: true }).decision, "allow");
  });

  it("never fires on prose-only rules", () => {
    const result = evaluate("echo hello");
    assert.equal(result.decision, "allow");
    assert.equal(result.hits.length, 0);
  });

  it("respects agent and channel scoping", () => {
    store.saveRule({
      id: "rule-claude-only",
      title: "Claude 专属",
      body: "只对 claude 生效",
      severity: "blocked",
      priority: 5,
      match: { agents: ["claude"], tools: ["shell"], commandPatterns: ["^ls\\b"] },
    });
    service.invalidate();
    assert.equal(evaluate("ls -la", { agent: "codex" }).decision, "allow");
    assert.equal(evaluate("ls -la", { agent: "claude" }).decision, "deny");
  });

  it("observes without blocking in observe mode", () => {
    const gate = createRuleEnforcementGate({ service, mode: "observe" });
    const result = gate.evaluate({
      agent: "codex",
      channel: "telegram",
      workspace: "/tmp",
      tool: "shell",
      command: "killall node",
      userExplicitlyApproved: false,
    });
    assert.equal(result.decision, "deny");
    assert.equal(result.effectiveDecision, "allow");
    assert.equal(result.mode, "observe");
  });

  it("ignores rules whose regex fails to compile instead of throwing", () => {
    store.saveRule({
      id: "rule-broken",
      title: "坏正则",
      body: "bad",
      severity: "blocked",
      priority: 1,
      match: { tools: ["shell"], commandPatterns: ["([unclosed"] },
    });
    service.invalidate();
    assert.equal(evaluate("echo safe").decision, "allow");
  });
});
