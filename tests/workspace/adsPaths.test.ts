import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../../server/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("workspace/adsPaths migrateLegacyWorkspaceAdsIfNeeded", () => {
  let workspace: string;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-adsPaths-"));
    adsState = installTempAdsStateDir("ads-state-adsPaths-");
  });

  afterEach(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

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
