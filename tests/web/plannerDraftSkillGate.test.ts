import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PLANNER_DRAFT_SKILL_ID,
  buildPlannerDraftSkillMissingMessage,
  isPlannerDraftSkillAvailable,
} from "../../server/web/server/planner/draftSlashCommand.js";
import { resetSkillFileCacheForTests } from "../../server/skills/loader.js";

describe("web/planner draft skill gate", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-draft-skill-gate-"));
    resetSkillFileCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSkillFileCacheForTests();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("ships with ADS, so it resolves from a workspace that has no skills of its own", () => {
    // The whole point of shipping the skill in the ADS repo: an arbitrary user
    // project gets /draft without installing anything, on any provider CLI.
    assert.equal(isPlannerDraftSkillAvailable(tmpDir), true);
  });

  it("reports unavailable when the registry disables the skill", () => {
    const metadataPath = path.join(tmpDir, "metadata.yaml");
    fs.writeFileSync(metadataPath, `mode: overlay\nskills:\n  ${PLANNER_DRAFT_SKILL_ID}:\n    enabled: false\n`, "utf8");
    process.env.ADS_SKILLS_METADATA_PATH = metadataPath;

    assert.equal(isPlannerDraftSkillAvailable(tmpDir), false);
  });

  it("stays available when the registry only reprioritizes the skill", () => {
    const metadataPath = path.join(tmpDir, "metadata.yaml");
    fs.writeFileSync(metadataPath, `mode: overlay\nskills:\n  ${PLANNER_DRAFT_SKILL_ID}:\n    priority: 10\n`, "utf8");
    process.env.ADS_SKILLS_METADATA_PATH = metadataPath;

    assert.equal(isPlannerDraftSkillAvailable(tmpDir), true);
  });

  it("names the skill and a recovery path in the failure message", () => {
    const message = buildPlannerDraftSkillMissingMessage();
    assert.match(message, new RegExp(PLANNER_DRAFT_SKILL_ID));
    assert.match(message, /\.agent\/skills/);
  });
});
