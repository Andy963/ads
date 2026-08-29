import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SystemPromptManager } from "../../server/systemPrompt/manager.js";

function writeTemplates(templateRoot: string, extra?: Record<string, string>): void {
  fs.mkdirSync(templateRoot, { recursive: true });
  fs.writeFileSync(path.join(templateRoot, "instructions.md"), "# Shared instructions\n", "utf8");
  fs.writeFileSync(path.join(templateRoot, "rules.md"), "# Shared rules\n", "utf8");
  for (const [name, content] of Object.entries(extra ?? {})) {
    fs.writeFileSync(path.join(templateRoot, name), content, "utf8");
  }
}

describe("systemPrompt/lane instructions", () => {
  let tmpDir: string;
  let templateRoot: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-lane-instructions-"));
    templateRoot = path.join(tmpDir, "templates");
    workspaceRoot = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.ADS_REINJECTION_ENABLED = "false";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("injects the lane file for the lane that declares one", () => {
    writeTemplates(templateRoot, { "planner-instructions.md": "# Planner only\nWrite specs, not code.\n" });

    const manager = new SystemPromptManager({
      workspaceRoot,
      templateRoot,
      laneInstructionsFile: "planner-instructions.md",
    });

    const injection = manager.maybeInject();
    assert.ok(injection);
    assert.match(injection.text, /Shared instructions/);
    assert.match(injection.text, /Planner only/);
  });

  it("keeps the lane file out of lanes that declare none", () => {
    writeTemplates(templateRoot, { "planner-instructions.md": "# Planner only\nWrite specs, not code.\n" });

    const manager = new SystemPromptManager({ workspaceRoot, templateRoot });

    const injection = manager.maybeInject();
    assert.ok(injection);
    assert.match(injection.text, /Shared instructions/);
    assert.doesNotMatch(injection.text, /Planner only/);
  });

  it("still injects shared instructions when the lane file is missing", () => {
    writeTemplates(templateRoot);

    const manager = new SystemPromptManager({
      workspaceRoot,
      templateRoot,
      laneInstructionsFile: "planner-instructions.md",
    });

    const injection = manager.maybeInject();
    assert.ok(injection);
    assert.match(injection.text, /Shared instructions/);
  });

  it("reinjects after the lane file changes on disk", () => {
    writeTemplates(templateRoot, { "planner-instructions.md": "# Planner only\nVersion one.\n" });

    const manager = new SystemPromptManager({
      workspaceRoot,
      templateRoot,
      laneInstructionsFile: "planner-instructions.md",
    });

    const first = manager.maybeInject();
    assert.match(first?.text ?? "", /Version one/);

    manager.completeTurn();
    // Rules reinject on their own cadence; that pass must not drag the lane
    // instructions along, or every turn would repeat them.
    const rulesOnly = manager.maybeInject();
    if (rulesOnly) {
      assert.doesNotMatch(rulesOnly.text, /Version one/);
    }

    fs.writeFileSync(path.join(templateRoot, "planner-instructions.md"), "# Planner only\nVersion two.\n", "utf8");

    const second = manager.maybeInject();
    assert.ok(second, "a changed lane file must trigger reinjection");
    assert.match(second.text, /Version two/);
  });
});
