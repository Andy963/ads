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
  isWorkspaceInitialized,
} from "../../server/workspace/detector.js";
import { withWorkspaceContext } from "../../server/workspace/asyncWorkspaceContext.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../../server/workspace/adsPaths.js";
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

    assert.equal(fs.existsSync(path.join(workspace, "docs", "spec")), false, "docs/spec should not be created during initialization");
  });

  it("does not create legacy prompt templates", () => {
    initializeWorkspace(workspace, "No Template Test");
    assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "templates")), false);
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

  it("normalizes nested workspace inputs across detector helpers", () => {
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const nested = path.join(workspace, "nested", "dir");
    fs.mkdirSync(nested, { recursive: true });

    const previousDbPath = process.env.ADS_DATABASE_PATH;
    delete process.env.ADS_DATABASE_PATH;
    try {
      const initializedRoot = initializeWorkspace(nested, "Nested Init Test");
      assert.equal(initializedRoot, path.resolve(workspace));
      assert.equal(isWorkspaceInitialized(nested), true);

      const dbPath = getWorkspaceDbPath(nested);
      assert.equal(dbPath, resolveWorkspaceStatePath(workspace, "ads.db"));
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "rules")), false);
      assert.equal(fs.existsSync(path.join(workspace, "docs", "spec")), false);
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "templates")), false);
      assert.equal(
        fs.existsSync(path.join(nested, "docs", "spec")),
        false,
        "nested child directory should not get its own docs/spec"
      );
    } finally {
      if (previousDbPath === undefined) {
        delete process.env.ADS_DATABASE_PATH;
      } else {
        process.env.ADS_DATABASE_PATH = previousDbPath;
      }
    }
  });

  describe("workspace/adsPaths migrateLegacyWorkspaceAdsIfNeeded", () => {
    it("backfills missing files/directories and keeps migration idempotent", () => {
      const legacyDir = path.join(workspace, ".ads");
      fs.mkdirSync(path.join(legacyDir, "commands"), { recursive: true });

      fs.writeFileSync(path.join(legacyDir, "workspace.json"), JSON.stringify({ name: "legacy", version: "1.0" }), "utf8");
      fs.writeFileSync(path.join(legacyDir, "ads.db"), "LEGACY_ADS_DB", "utf8");
      fs.writeFileSync(path.join(legacyDir, "state.db"), "LEGACY_STATE_DB", "utf8");
      fs.writeFileSync(path.join(legacyDir, "intake-state.json"), "{\"x\":1}", "utf8");
      fs.writeFileSync(path.join(legacyDir, "context.json"), "{\"y\":2}", "utf8");
      fs.mkdirSync(path.join(legacyDir, "templates"), { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "templates", "instructions.md"), "LEGACY_TEMPLATE", "utf8");
      fs.writeFileSync(path.join(legacyDir, "commands", "command.md"), "COMMAND_FILE", "utf8");

      assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), true);

      assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "ads.db"), "utf8"), "LEGACY_ADS_DB");
      assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "state.db"), "utf8"), "LEGACY_STATE_DB");
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "templates")), false);
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "rules.md")), false);
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "templates", "rules.md")), false);
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "rules")), false);
      assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "commands", "command.md"), "utf8"), "COMMAND_FILE");

      assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), false, "second migration should be a no-op");
    });

    it("does not overwrite existing state files when backfilling", () => {
      const legacyDir = path.join(workspace, ".ads");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "workspace.json"), JSON.stringify({ name: "legacy", version: "1.0" }), "utf8");

      const stateConfig = resolveWorkspaceStatePath(workspace, "workspace.json");
      fs.mkdirSync(path.dirname(stateConfig), { recursive: true });
      fs.writeFileSync(stateConfig, JSON.stringify({ name: "state", version: "1.0" }), "utf8");

      assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), false);
      assert.equal(fs.readFileSync(stateConfig, "utf8"), JSON.stringify({ name: "state", version: "1.0" }));
    });
  });
});
