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
    fs.mkdirSync(path.join(legacyDir, "templates"), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, "rules"), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, "commands"), { recursive: true });

    fs.writeFileSync(path.join(legacyDir, "workspace.json"), JSON.stringify({ name: "legacy", version: "1.0" }), "utf8");
    fs.writeFileSync(path.join(legacyDir, "ads.db"), "LEGACY_ADS_DB", "utf8");
    fs.writeFileSync(path.join(legacyDir, "state.db"), "LEGACY_STATE_DB", "utf8");
    fs.writeFileSync(path.join(legacyDir, "rules.md"), "LEGACY_RULES_MD", "utf8");
    fs.writeFileSync(path.join(legacyDir, "intake-state.json"), "{\"x\":1}", "utf8");
    fs.writeFileSync(path.join(legacyDir, "context.json"), "{\"y\":2}", "utf8");
    fs.writeFileSync(path.join(legacyDir, "instructions.md"), "ROOT_INSTRUCTIONS", "utf8");
    fs.writeFileSync(path.join(legacyDir, "templates", "instructions.md"), "TEMPLATE_INSTRUCTIONS", "utf8");
    fs.writeFileSync(path.join(legacyDir, "templates", "rules.md"), "TEMPLATE_RULES", "utf8");
    fs.writeFileSync(path.join(legacyDir, "rules", "custom-rule.md"), "RULE_FILE", "utf8");
    fs.writeFileSync(path.join(legacyDir, "commands", "command.md"), "COMMAND_FILE", "utf8");

    assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), true);

    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "ads.db"), "utf8"), "LEGACY_ADS_DB");
    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "state.db"), "utf8"), "LEGACY_STATE_DB");
    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "rules.md"), "utf8"), "LEGACY_RULES_MD");
    assert.equal(
      fs.readFileSync(resolveWorkspaceStatePath(workspace, "templates", "instructions.md"), "utf8"),
      "TEMPLATE_INSTRUCTIONS",
      "templates/instructions.md should be preferred over root .ads/instructions.md"
    );
    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "templates", "rules.md"), "utf8"), "TEMPLATE_RULES");
    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "rules", "custom-rule.md"), "utf8"), "RULE_FILE");
    assert.equal(fs.readFileSync(resolveWorkspaceStatePath(workspace, "commands", "command.md"), "utf8"), "COMMAND_FILE");

    assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), false, "second migration should be a no-op");
  });

  it("does not overwrite existing state files when backfilling", () => {
    const legacyDir = path.join(workspace, ".ads");
    fs.mkdirSync(path.join(legacyDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "workspace.json"), JSON.stringify({ name: "legacy", version: "1.0" }), "utf8");
    fs.writeFileSync(path.join(legacyDir, "templates", "instructions.md"), "LEGACY_TEMPLATE_INSTRUCTIONS", "utf8");
    fs.writeFileSync(path.join(legacyDir, "instructions.md"), "LEGACY_ROOT_INSTRUCTIONS", "utf8");

    const stateInstructions = resolveWorkspaceStatePath(workspace, "templates", "instructions.md");
    fs.mkdirSync(path.dirname(stateInstructions), { recursive: true });
    fs.writeFileSync(resolveWorkspaceStatePath(workspace, "workspace.json"), JSON.stringify({ name: "state", version: "1.0" }), "utf8");
    fs.writeFileSync(stateInstructions, "STATE_INSTRUCTIONS", "utf8");

    assert.equal(migrateLegacyWorkspaceAdsIfNeeded(workspace), false);
    assert.equal(fs.readFileSync(stateInstructions, "utf8"), "STATE_INSTRUCTIONS");
  });
});
