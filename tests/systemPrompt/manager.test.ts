import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SystemPromptManager } from "../../server/systemPrompt/manager.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";
import { setPreference } from "../../server/memory/soul.js";

describe("SystemPromptManager prompt injection", () => {
  let workspace: string;
  let templateRoot: string;
  let adsState: TempAdsStateDir | null = null;

  before(() => {
    adsState = installTempAdsStateDir("ads-state-systemprompt-");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-"));
    templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-templates-"));
    fs.writeFileSync(path.join(templateRoot, "instructions.md"), "System instructions");
    fs.writeFileSync(path.join(templateRoot, "rules.md"), "Legacy rules must not be injected");
  });

  after(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(templateRoot, { recursive: true, force: true });
  });

  it("does not inject the legacy rules file or use a rules-only cadence", () => {
    const manager = new SystemPromptManager({
      workspaceRoot: workspace,
      reinjection: { enabled: true, turns: 999 },
      templateRoot,
    });

    const initial = manager.maybeInject();
    assert(initial);
    assert.equal(initial.reason, "initial");
    assert.match(initial.text, /System instructions/);
    assert.doesNotMatch(initial.text, /Legacy rules/);

    for (let i = 0; i < 12; i += 1) {
      manager.completeTurn();
      assert.equal(manager.maybeInject(), null);
    }
  });

  it("detects instruction updates and workspace switch", () => {
    const manager = new SystemPromptManager({
      workspaceRoot: workspace,
      reinjection: { enabled: true, turns: 2 },
      templateRoot,
    });

    const initial = manager.maybeInject();
    assert(initial);
    assert.equal(initial.reason, "initial");

    fs.writeFileSync(path.join(templateRoot, "instructions.md"), "Updated instructions");
    manager.completeTurn();
    const updated = manager.maybeInject();
    assert(updated);
    assert.equal(updated.reason, "instructions-updated");
    assert.match(updated.text, /Updated instructions/);

    const nextWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-next-"));
    try {
      setPreference(nextWorkspace, "language", "Next English");
      manager.setWorkspaceRoot(nextWorkspace);
      const switched = manager.maybeInject();
      assert(switched);
      assert.equal(switched.reason, "workspace-changed");
      assert.match(switched.text, /Updated instructions/);
      assert.match(switched.text, /Next English/);
    } finally {
      fs.rmSync(nextWorkspace, { recursive: true, force: true });
    }
  });

  it("injects soul content into the prompt", () => {
    setPreference(workspace, "language", "English");
    setPreference(workspace, "tone", "casual");

    const manager = new SystemPromptManager({ workspaceRoot: workspace, templateRoot });
    const injection = manager.maybeInject();
    assert(injection);
    assert.match(injection.text, /<soul>/);
    assert.match(injection.text, /language/);
    assert.match(injection.text, /English/);
    assert.match(injection.text, /tone/);
    assert.match(injection.text, /casual/);
  });

  it("does not inject a soul block when the soul file is empty", () => {
    const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-nosoul-"));
    try {
      const manager = new SystemPromptManager({ workspaceRoot: emptyWorkspace, templateRoot });
      const injection = manager.maybeInject();
      assert(injection);
      assert.doesNotMatch(injection.text, /<soul>/);
    } finally {
      fs.rmSync(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("does not require explicit workspace initialization", () => {
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-uninit-"));
    try {
      const manager = new SystemPromptManager({ workspaceRoot: tempWorkspace, templateRoot });
      const injection = manager.maybeInject();
      assert(injection);
      assert.equal(injection.reason, "initial");
      assert.notEqual(injection.instructionsHash, "missing");
      assert.ok(injection.text.trim().length > 0);
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});
