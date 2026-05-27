import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeToolDirectives, extractToolDirectives, stripToolDirectives } from "../../server/skills/builtinTools.js";
import { readMemory } from "../../server/memory/memory.js";

describe("skills/builtinTools", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tools-"));
  });

  afterEach(() => {
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
});
