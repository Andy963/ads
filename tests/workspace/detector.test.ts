import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initializeWorkspace,
  detectWorkspace,
  detectWorkspaceFrom,
  getWorkspaceDbPath,
  getWorkspaceSpecsDir,
  isWorkspaceInitialized,
  ensureDefaultTemplates,
} from "../../src/workspace/detector.js";
import { withWorkspaceContext } from "../../src/workspace/asyncWorkspaceContext.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("workspace/detector", () => {
  let workspace: string;
  let originalEnv: Record<string, string | undefined>;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-detector-"));
    originalEnv = {
      AD_WORKSPACE: process.env.AD_WORKSPACE,
      ADS_DATABASE_PATH: process.env.ADS_DATABASE_PATH,
      ADS_STATE_DIR: process.env.ADS_STATE_DIR,
    };
    process.env.AD_WORKSPACE = workspace;
    process.env.ADS_DATABASE_PATH = path.join(workspace, "ads-test.db");
    adsState = installTempAdsStateDir("ads-state-detector-");
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    process.env.ADS_DATABASE_PATH = originalEnv.ADS_DATABASE_PATH;
    if (originalEnv.ADS_STATE_DIR === undefined) {
      delete process.env.ADS_STATE_DIR;
    } else {
      process.env.ADS_STATE_DIR = originalEnv.ADS_STATE_DIR;
    }
    adsState?.restore();
    adsState = null;
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
    const templatesDir = resolveWorkspaceStatePath(workspace, "templates");
    const files = fs.readdirSync(templatesDir);
    assert.ok(files.includes("instructions.md"), "instructions template should exist");
    assert.ok(files.includes("rules.md"), "rules template should exist");
  });

  it("detects workspace root from a nested directory", () => {
    initializeWorkspace(workspace, "Nested Detector Test");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const nested = path.join(workspace, "nested", "dir");
    fs.mkdirSync(nested, { recursive: true });

    const detected = detectWorkspaceFrom(nested);
    assert.equal(detected, path.resolve(workspace));
  });

  it("normalizes async workspace context to git root", async () => {
    initializeWorkspace(workspace, "Context Detector Test");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const nested = path.join(workspace, "nested", "context");
    fs.mkdirSync(nested, { recursive: true });

    const prev = process.env.AD_WORKSPACE;
    delete process.env.AD_WORKSPACE;
    try {
      const detected = await withWorkspaceContext(nested, () => detectWorkspace());
      assert.equal(detected, path.resolve(workspace));
    } finally {
      if (prev === undefined) {
        delete process.env.AD_WORKSPACE;
      } else {
        process.env.AD_WORKSPACE = prev;
      }
    }
  });
});
