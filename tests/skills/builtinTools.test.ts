import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeToolDirectives, extractToolDirectives, stripToolDirectives } from "../../server/skills/builtinTools.js";
import { readMemory } from "../../server/memory/memory.js";
import { LaneDispatchBus } from "../../server/actions/bus.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { getBus, setBusInstance } from "../../server/web/server/api/routes/actions.js";

describe("skills/builtinTools", () => {
  let workspace: string;
  let bus: LaneDispatchBus;
  let previousBus: LaneDispatchBus;

  beforeEach((t) => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tools-"));
    previousBus = getBus();
    bus = new LaneDispatchBus(getStateDatabase(path.join(workspace, "state.db")));
    t.mock.method(bus, "evaluateQueue", async () => ({ allowed: false }));
    setBusInstance(bus);
  });

  afterEach(async () => {
    await Promise.resolve();
    setBusInstance(previousBus);
    resetStateDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("extracts and strips tool directives", () => {
    const text = 'hello\n<<<tool.memory.update op="add">>>\n- Fact\n>>>\nbye';
    const directives = extractToolDirectives(text);
    assert.equal(directives.length, 1);
    assert.equal(directives[0]?.name, "memory.update");
    assert.equal(stripToolDirectives(text), "hello\n\nbye");
  });

  it("executes memory update directives", async () => {
    const results = await executeToolDirectives({
      text: '<<<tool.memory.update op="add">>>\n- Stored fact\n>>>',
      workspaceRoot: workspace,
    });
    assert.match(results[0] ?? "", /ok/);
    assert.match(readMemory(workspace), /Stored fact/);
  });

  it("rejects dispatch directives without a complete Issue contract", async () => {
    const results = await executeToolDirectives({
      text: '<<<tool.dispatch_action_job issue_id="277" title="Incomplete Issue">>>\n>>>',
      workspaceRoot: workspace,
    });
    assert.match(results[0] ?? "", /failed: dispatch_action_job requires an explicit acceptance_criteria field/);
  });

  it("rejects local prompt directives without explicit acceptance criteria", async () => {
    const results = await executeToolDirectives({
      text: '<<<tool.dispatch_action_job kind="local_prompt" title="Local task">>>\nComplete local prompt\n>>>',
      workspaceRoot: workspace,
    });
    assert.match(results[0] ?? "", /failed: dispatch_action_job requires an explicit acceptance_criteria field/);
  });

  it("dispatches text aliases with the shared contract and trusted context", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    const results = await executeToolDirectives({
      text: '<<<tool.dispatch_action_job issue="516" issue_title="Shared dispatch" acceptance_criteria=" Verify both runtimes | Preserve host binding ">>>\nComplete issue description\n>>>',
      workspaceRoot: workspace,
      authUserId: "trusted-owner",
    });
    assert.equal(dispatch.mock.callCount(), 1);
    const result = dispatch.mock.calls[0].result!;
    assert.deepEqual(results, [`tool.dispatch_action_job: ok (job_id: ${result.jobId}, status: queued)`]);
    assert.deepEqual(dispatch.mock.calls[0].arguments[0], {
      projectId: workspace, repoPath: workspace, authUserId: "trusted-owner",
      issueId: 516, issueTitle: "Shared dispatch", issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify both runtimes", "Preserve host binding"], jobKind: "github_issue",
    });
    assert.equal(bus.getJob(result.jobId)?.status, "queued");
  });

  it("preserves default titles and explicit empty local-prompt criteria", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    await executeToolDirectives({
      text: '<<<tool.dispatch_action_job kind="local_prompt" acceptance_criteria="">>>\nComplete local prompt\n>>>\n<<<tool.dispatch_action_job issue="516" acceptance_criteria="Verify issue">>>\nComplete issue description\n>>>',
      workspaceRoot: workspace,
    });
    assert.equal(dispatch.mock.callCount(), 2);
    assert.equal(dispatch.mock.calls[0].arguments[0].issueTitle, "Task");
    assert.deepEqual(dispatch.mock.calls[0].arguments[0].acceptanceCriteria, []);
    assert.equal(dispatch.mock.calls[0].arguments[0].jobKind, "local_prompt");
    assert.equal(dispatch.mock.calls[1].arguments[0].issueTitle, "Issue #516");
  });

  it("rejects overrides, invalid kinds, invalid issue numbers and empty contracts before dispatch", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    for (const attrs of [
      'kind="secret-invalid-kind"', 'issue_id="0"', 'issue_id="-1"', 'issue_id="1.5"', 'issue="secret-invalid-number"',
      'title=" "', 'acceptance_criteria=""',
      ...["workspaceRoot", "workspace_root", "repoPath", "repo_path", "projectId", "project_id", "authUserId", "auth_user_id", "owner", "profile", "developerProfileId", "reviewerProfileIds", "__proto__"]
        .map((key) => `${key}="secret-override"`),
    ]) {
      const results = await executeToolDirectives({
        text: `<<<tool.dispatch_action_job title="Task" acceptance_criteria="Verify dispatch" ${attrs}>>>\nComplete issue description\n>>>`,
        workspaceRoot: workspace,
      });
      assert.match(results[0], /failed:/);
      assert.doesNotMatch(results[0], /secret-/);
    }
    assert.equal(dispatch.mock.callCount(), 0);
  });

  it("rejects cancelled directives and sanitizes unknown tools and queue errors", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob", () => { throw new Error("secret-queue-error"); });
    const text = '<<<tool.dispatch_action_job title="Task" acceptance_criteria="Verify dispatch">>>\nComplete issue description\n>>>';
    const controller = new AbortController();
    controller.abort(new Error("secret-abort-reason"));
    const cancelled = await executeToolDirectives({ text, workspaceRoot: workspace, signal: controller.signal });
    assert.deepEqual(cancelled, ["tool.dispatch_action_job: failed: Aborted"]);
    assert.equal(dispatch.mock.callCount(), 0);
    const unknown = await executeToolDirectives({
      text: '<<<tool.secret-tool-name>>>\nsecret-payload\n>>>', workspaceRoot: workspace,
    });
    assert.deepEqual(unknown, ["tool.unknown: rejected (unknown tool)"]);
    const failed = await executeToolDirectives({ text, workspaceRoot: workspace });
    assert.deepEqual(failed, ["tool.dispatch_action_job: failed: Unable to dispatch Actions job"]);
    assert.equal(dispatch.mock.callCount(), 1);
  });
});
