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
