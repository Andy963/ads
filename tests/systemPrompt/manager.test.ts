import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SystemPromptManager } from "../../src/systemPrompt/manager.js";

describe("SystemPromptManager rule reinjection", () => {
  let workspace: string;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-"));
    const adsDir = path.join(workspace, ".ads");
    const templatesDir = path.join(adsDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, "instructions.md"), "System instructions");
    fs.writeFileSync(path.join(templatesDir, "rules.md"), "Template rules");
    fs.writeFileSync(path.join(adsDir, "rules.md"), "Workspace rules");
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("re-injects rules every five turns", () => {
    const manager = new SystemPromptManager({
      workspaceRoot: workspace,
      reinjection: { enabled: true, turns: 999, rulesTurns: 5 },
    });

    const initial = manager.maybeInject();
    assert(initial);
    assert.equal(initial.reason, "initial");

    for (let i = 0; i < 4; i += 1) {
      manager.completeTurn();
    }

    const beforeThreshold = manager.maybeInject();
    assert.equal(beforeThreshold, null);

    manager.completeTurn();
    const reinjected = manager.maybeInject();
    assert(reinjected);
    assert.equal(reinjected.reason, "rules-only-5");
  });

  it("injects workspace rules every turn by default", () => {
    const manager = new SystemPromptManager({
      workspaceRoot: workspace,
      reinjection: { enabled: true, turns: 999 },
    });

    const initial = manager.maybeInject();
    assert(initial);
    assert.equal(initial.reason, "initial");

    manager.completeTurn();
    let injection = manager.maybeInject();
    assert(injection);
    assert.equal(injection.reason, "rules-only-1");

    manager.completeTurn();
    injection = manager.maybeInject();
    assert(injection);
    assert.equal(injection.reason, "rules-only-2");
  });

  it("detects instruction updates and workspace switch", () => {
    const manager = new SystemPromptManager({
      workspaceRoot: workspace,
      reinjection: { enabled: true, turns: 2, rulesTurns: 2 },
    });

    const initial = manager.maybeInject();
    assert(initial);
    assert.equal(initial.reason, "initial");

    // Modify instructions to trigger pending reason
    const instructionsPath = path.join(workspace, ".ads", "templates", "instructions.md");
    fs.writeFileSync(instructionsPath, "Updated instructions");
    manager.completeTurn();
    const updated = manager.maybeInject();
    assert(updated);
    assert.equal(updated.reason, "instructions-updated");

    // Switch workspace and ensure reset
    const nextWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-next-"));
    const nextAds = path.join(nextWorkspace, ".ads", "templates");
    fs.mkdirSync(nextAds, { recursive: true });
    fs.writeFileSync(path.join(nextAds, "instructions.md"), "Next instructions");
    fs.writeFileSync(path.join(nextAds, "rules.md"), "Next rules");
    manager.setWorkspaceRoot(nextWorkspace);
    manager.completeTurn();
    const switched = manager.maybeInject();
    assert(switched);
    assert.equal(switched.reason, "workspace-changed");

    fs.rmSync(nextWorkspace, { recursive: true, force: true });
  });

  it("falls back to default templates when workspace is not initialized", () => {
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-uninit-"));
    try {
      const manager = new SystemPromptManager({ workspaceRoot: tempWorkspace });
      const injection = manager.maybeInject();
      assert(injection, "should inject fallback instructions");
      assert.equal(injection.reason, "initial");
      assert.notEqual(injection.instructionsHash, "missing");
      assert.ok(injection.text.trim().length > 0, "fallback instructions should not be empty");
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});
