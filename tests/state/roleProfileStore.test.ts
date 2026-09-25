import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import {
  getRoleProfiles,
  getDefaultRoleProfile,
  saveRoleProfile,
  getRoleSettingsHistory,
} from "../../server/state/roleProfileStore.js";

describe("state/roleProfileStore", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-role-store-test-"));
    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("retrieves seeded default role profiles", () => {
    const db = getStateDatabase();
    const allProfiles = getRoleProfiles(db);
    assert.ok(allProfiles.length >= 3);

    const acopilot = getDefaultRoleProfile(db, "acopilot");
    const developer = getDefaultRoleProfile(db, "developer");
    const reviewer = getDefaultRoleProfile(db, "reviewer");

    assert.ok(acopilot);
    assert.strictEqual(acopilot.role, "acopilot");
    assert.strictEqual(acopilot.is_default, 1);

    assert.ok(developer);
    assert.strictEqual(developer.role, "developer");
    assert.strictEqual(developer.is_default, 1);

    assert.ok(reviewer);
    assert.strictEqual(reviewer.role, "reviewer");
    assert.strictEqual(reviewer.is_default, 1);
  });

  it("keeps the Developer and Reviewer roles in separate, independently-defaulted profiles", () => {
    const db = getStateDatabase();

    // The role_profiles vocabulary holds a lane-level `acopilot` profile
    // alongside the two Actions roles, so a role filter must select exactly
    // one role and never bleed into another.
    for (const role of ["acopilot", "developer", "reviewer"] as const) {
      const rows = getRoleProfiles(db, role);
      assert.ok(rows.length > 0, `expected at least one ${role} profile`);
      assert.ok(
        rows.every((row) => row.role === role),
        `role filter ${role} returned a foreign role: ${rows.map((r) => r.role).join(",")}`,
      );
    }

    const developerDefault = getDefaultRoleProfile(db, "developer");
    const reviewerDefault = getDefaultRoleProfile(db, "reviewer");
    assert.ok(developerDefault && reviewerDefault);
    assert.notStrictEqual(developerDefault.id, reviewerDefault.id);
    assert.notStrictEqual(developerDefault.system_prompt, reviewerDefault.system_prompt);

    // Promoting a Developer default must not clear the Reviewer default: the
    // reset is scoped by role, which is what keeps the detached Reviewer
    // context from being merged into the Developer one.
    const promoted = saveRoleProfile(db, {
      id: "profile-developer-alt",
      role: "developer",
      name: "Developer Alternate",
      model_id: "gpt-5.6",
      system_prompt: "Developer alternate prompt",
      is_default: true,
    });
    assert.strictEqual(promoted.role, "developer");

    assert.strictEqual(getDefaultRoleProfile(db, "developer")?.id, "profile-developer-alt");

    // Assert the is_default flag itself rather than the returned id:
    // getDefaultRoleProfile falls back to any row for the role when no default
    // is flagged, so comparing ids would pass even if the promotion had
    // cleared every other role's default.
    assert.strictEqual(
      getRoleProfiles(db, "reviewer").filter((row) => row.is_default === 1).length,
      1,
      "the Reviewer must keep exactly one flagged default after a Developer promotion",
    );
    assert.strictEqual(
      getRoleProfiles(db, "acopilot").filter((row) => row.is_default === 1).length,
      1,
      "the Acopilot lane profile must keep exactly one flagged default after a Developer promotion",
    );
    assert.strictEqual(
      getRoleProfiles(db, "developer").filter((row) => row.is_default === 1).length,
      1,
      "promoting a Developer default must leave exactly one Developer default",
    );
  });

  it("saves a new role profile and updates default status and history", () => {
    const db = getStateDatabase();
    const newProfile = saveRoleProfile(db, {
      id: "profile-acopilot-gemini",
      role: "acopilot",
      name: "Acopilot Gemini Pro",
      model_id: "gemini-2.5-pro",
      reasoning_effort: "medium",
      system_prompt: "Custom system prompt for testing",
      is_default: true,
    });

    assert.strictEqual(newProfile.id, "profile-acopilot-gemini");
    assert.strictEqual(newProfile.version, 1);
    assert.strictEqual(newProfile.is_default, 1);

    const defaultProfile = getDefaultRoleProfile(db, "acopilot");
    assert.ok(defaultProfile);
    assert.strictEqual(defaultProfile.id, "profile-acopilot-gemini");

    const history = getRoleSettingsHistory(db, "acopilot");
    assert.ok(history.length >= 2);
    assert.strictEqual(history[0]?.model_id, "gemini-2.5-pro");
  });
});
