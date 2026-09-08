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

  it("injects the configured Advisor and Worker lane prompts", () => {
    const advisor = new SystemPromptManager({ workspaceRoot: workspace, lane: "advisor" });
    const worker = new SystemPromptManager({ workspaceRoot: workspace, lane: "worker" });

    const advisorInjection = advisor.maybeInject();
    const workerInjection = worker.maybeInject();

    assert(advisorInjection);
    assert(workerInjection);
    assert.match(advisorInjection.text, /ADS Advisor/);
    assert.doesNotMatch(advisorInjection.text, /You are the ADS Worker/);
    assert.match(workerInjection.text, /ADS Worker/);
    assert.doesNotMatch(workerInjection.text, /You are the ADS Advisor/);
  });

  it("hot-loads a new database version on the next injection", () => {
    const store = createLanePromptStore(getStateDatabase());
    const manager = new SystemPromptManager({ workspaceRoot: workspace, lane: "advisor", lanePromptStore: store });

    const initial = manager.maybeInject();
    assert(initial);
    assert.match(initial.text, /ADS Advisor/);

    store.setLanePrompt("advisor", "Custom advisor prompt");
    manager.completeTurn();
    const updated = manager.maybeInject();

    assert(updated);
    assert.equal(updated.reason, "lane-prompt-updated");
    assert.match(updated.text, /Custom advisor prompt/);
  });

  it("does not inject a lane prompt when no lane is assigned", () => {
    const manager = new SystemPromptManager({ workspaceRoot: workspace });
    const injection = manager.maybeInject();

    if (injection) {
      assert.doesNotMatch(injection.text, /Advisor lane|Worker lane/);
    }
  });

  it("does not read legacy templates or soul files", () => {
    fs.writeFileSync(path.join(workspace, "soul.md"), "secret preference\n", "utf8");
    const manager = new SystemPromptManager({ workspaceRoot: workspace, lane: "worker" });
    const injection = manager.maybeInject();

    assert(injection);
    assert.doesNotMatch(injection.text, /secret preference/);
    assert.doesNotMatch(injection.text, /planner-instructions|System instructions/);
  });
});
