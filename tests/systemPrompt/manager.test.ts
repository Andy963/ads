import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase } from "../../server/state/database.js";
import { createLanePromptStore } from "../../server/state/lanePromptStore.js";
import { SystemPromptManager } from "../../server/systemPrompt/manager.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("SystemPromptManager prompt injection", () => {
  let workspace: string;
  let adsState: TempAdsStateDir | null = null;

  before(() => {
    adsState = installTempAdsStateDir("ads-state-systemprompt-");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-systemprompt-"));
  });

  after(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("injects the configured Acopilot and Actions lane prompts", () => {
    const acopilot = new SystemPromptManager({ workspaceRoot: workspace, lane: "acopilot" });
    const actions = new SystemPromptManager({ workspaceRoot: workspace, lane: "actions" });

    const acopilotInjection = acopilot.maybeInject();
    const actionsInjection = actions.maybeInject();

    assert(acopilotInjection);
    assert(actionsInjection);
    assert.match(acopilotInjection.text, /ADS Acopilot/);
    assert.doesNotMatch(acopilotInjection.text, /You are the ADS Actions Developer/);
    assert.match(actionsInjection.text, /ADS Actions Developer/);
    assert.doesNotMatch(actionsInjection.text, /You are the ADS Acopilot/);
  });

  it("resolves a legacy lane id to the same canonical prompt", () => {
    // Compatibility matrix: legacy spellings are accepted on read and must
    // resolve to the canonical lane's prompt, not a separate one.
    for (const legacy of ["advisor", "planner"] as const) {
      const manager = new SystemPromptManager({ workspaceRoot: workspace, lane: legacy as never });
      const injection = manager.maybeInject();
      assert(injection, `${legacy} should still resolve`);
      assert.match(injection.text, /ADS Acopilot/);
    }

    const workerManager = new SystemPromptManager({ workspaceRoot: workspace, lane: "worker" as never });
    const workerInjection = workerManager.maybeInject();
    assert(workerInjection);
    assert.match(workerInjection.text, /ADS Actions Developer/);
  });

  it("hot-loads a new database version on the next injection", () => {
    const store = createLanePromptStore(getStateDatabase());
    const manager = new SystemPromptManager({ workspaceRoot: workspace, lane: "acopilot", lanePromptStore: store });

    const initial = manager.maybeInject();
    assert(initial);
    assert.match(initial.text, /ADS Acopilot/);

    store.setLanePrompt("acopilot", "Custom acopilot prompt");
    manager.completeTurn();
    const updated = manager.maybeInject();

    assert(updated);
    assert.equal(updated.reason, "lane-prompt-updated");
    assert.match(updated.text, /Custom acopilot prompt/);
  });

  it("does not inject a lane prompt when no lane is assigned", () => {
    const manager = new SystemPromptManager({ workspaceRoot: workspace });
    const injection = manager.maybeInject();

    if (injection) {
      assert.doesNotMatch(injection.text, /You are the ADS (?:Acopilot|Actions Developer)/);
    }
  });

  it("does not read legacy templates or soul files", () => {
    fs.writeFileSync(path.join(workspace, "soul.md"), "secret preference\n", "utf8");
    const manager = new SystemPromptManager({ workspaceRoot: workspace, lane: "actions" });
    const injection = manager.maybeInject();

    assert(injection);
    assert.doesNotMatch(injection.text, /secret preference/);
    assert.doesNotMatch(injection.text, /advisor-instructions|System instructions/);
  });
});
