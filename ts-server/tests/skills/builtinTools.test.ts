import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeToolDirectives, extractToolDirectives, stripToolDirectives } from "../../server/skills/builtinTools.js";
import { readMemory } from "../../server/memory/memory.js";

describe("skills/builtinTools", () => {
  let workspace: string;

  afterEach(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("extracts and strips tool directives", () => {
    const text = 'hello\n<<<tool.memory.update op="add">>>\n- Fact\n>>>\nbye';
    const directives = extractToolDirectives(text);
    assert.equal(directives.length, 1);
    assert.equal(directives[0]?.name, "memory.update");
    assert.equal(stripToolDirectives(text), "hello\n\nbye");
  });

  it("executes memory update directives", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tools-"));
    const results = await executeToolDirectives({
      text: '<<<tool.memory.update op="add">>>\n- Stored fact\n>>>',
      workspaceRoot: workspace,
    });
    assert.match(results[0] ?? "", /ok/);
    assert.match(readMemory(workspace), /Stored fact/);
  });

  it("rejects retired asynchronous dispatch directives", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tools-"));
    const results = await executeToolDirectives({
      text: '<<<tool.dispatch_action_job issue_id="277" title="Task" acceptance_criteria="Verify retirement">>>\nComplete task\n>>>',
      workspaceRoot: workspace,
    });
    assert.deepEqual(results, ["tool.unknown: rejected (unknown tool)"]);
  });

  it("sanitizes unknown directive names", async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tools-"));
    const results = await executeToolDirectives({
      text: '<<<tool.secret-tool-name>>>\nsecret-payload\n>>>',
      workspaceRoot: workspace,
    });
    assert.deepEqual(results, ["tool.unknown: rejected (unknown tool)"]);
  });
});
