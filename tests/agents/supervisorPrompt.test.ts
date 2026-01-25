import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SupervisorPromptLoader } from "../../src/agents/tasks/supervisorPrompt.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("agents/tasks/supervisorPrompt", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string | null = null;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    const scratchRoot = path.join(process.cwd(), ".ads-test-tmp");
    fs.mkdirSync(scratchRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(scratchRoot, "supervisor-prompt-"));
    process.env = { ...originalEnv };
    adsState = installTempAdsStateDir("ads-state-supervisor-");
  });

  afterEach(() => {
    adsState?.restore();
    adsState = null;
    process.env = { ...originalEnv };
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("loads workspace override when present", () => {
    assert.ok(tmpDir);
    const workspacePromptPath = resolveWorkspaceStatePath(tmpDir, "templates", "supervisor.md");
    fs.mkdirSync(path.dirname(workspacePromptPath), { recursive: true });
    fs.writeFileSync(workspacePromptPath, "workspace prompt", "utf8");

    const loader = new SupervisorPromptLoader();
    const result = loader.load(tmpDir);
    assert.equal(result.source, "workspace");
    assert.equal(result.text.trim(), "workspace prompt");
    assert.equal(path.resolve(result.path), path.resolve(workspacePromptPath));
  });

  it("falls back to built-in templates when workspace file is missing", () => {
    assert.ok(tmpDir);
    const loader = new SupervisorPromptLoader();
    const result = loader.load(tmpDir);
    assert.ok(["default", "missing"].includes(result.source));
    if (result.source === "default") {
      assert.ok(result.text.includes("Supervisor"), "should load built-in supervisor.md template");
    }
  });

  it("supports ADS_SUPERVISOR_PROMPT_PATH override", () => {
    assert.ok(tmpDir);
    const customPath = path.join(tmpDir, "custom-supervisor.md");
    fs.writeFileSync(customPath, "custom prompt", "utf8");
    process.env.ADS_SUPERVISOR_PROMPT_PATH = customPath;

    const loader = new SupervisorPromptLoader();
    const result = loader.load(tmpDir);
    assert.equal(result.source, "custom");
    assert.equal(result.text.trim(), "custom prompt");
    assert.equal(path.resolve(result.path), path.resolve(customPath));
  });
});
