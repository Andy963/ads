import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initializeWorkspace,
  detectWorkspace,
  getWorkspaceDbPath,
  getWorkspaceSpecsDir,
  isWorkspaceInitialized,
  ensureDefaultTemplates,
} from "../../src/workspace/detector.js";

describe("workspace/detector", () => {
  let workspace: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-detector-"));
    originalEnv = {
      AD_WORKSPACE: process.env.AD_WORKSPACE,
      ADS_DATABASE_PATH: process.env.ADS_DATABASE_PATH,
    };
    process.env.AD_WORKSPACE = workspace;
    process.env.ADS_DATABASE_PATH = path.join(workspace, "ads-test.db");
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    process.env.ADS_DATABASE_PATH = originalEnv.ADS_DATABASE_PATH;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("initializes workspace and detects it via env override", () => {
    initializeWorkspace(workspace, "Detector Test");
    assert.equal(isWorkspaceInitialized(workspace), true);

    const detected = detectWorkspace();
    assert.equal(detected, path.resolve(workspace));

    const dbPath = getWorkspaceDbPath(workspace);
    assert.equal(fs.existsSync(dbPath), true, "ads.db should be created");

    const specsDir = getWorkspaceSpecsDir(workspace);
    assert.equal(fs.existsSync(specsDir), true, "docs/spec should be created");
  });

  it("ensures default templates are copied", () => {
    initializeWorkspace(workspace, "Template Copy Test");
    ensureDefaultTemplates(workspace);
    const templatesDir = path.join(workspace, ".ads", "templates");
    const files = fs.readdirSync(templatesDir);
    assert.ok(files.includes("instructions.md"), "instructions template should exist");
    assert.ok(files.includes("rules.md"), "rules template should exist");
  });
});
