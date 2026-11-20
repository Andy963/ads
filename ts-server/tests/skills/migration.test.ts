import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateLegacyStateSkills } from "../../server/skills/migration.js";
import { runMigrationCli } from "../../server/skills/migrate.js";
import { discoverSkills } from "../../server/skills/loader.js";

describe("skills/migration", () => {
  let tempStateDir: string;
  let tempGlobalSkillsDir: string;
  let tempWorkspace: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-migration-state-"));
    tempGlobalSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-migration-global-skills-"));
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-migration-workspace-"));
    process.env.ADS_STATE_DIR = tempStateDir;
    process.env.CODEX_HOME = path.dirname(tempGlobalSkillsDir);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    fs.rmSync(tempGlobalSkillsDir, { recursive: true, force: true });
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it("migrates legacy skills from $ADS_STATE_DIR/.agent/skills to destination non-destructively", () => {
    const legacyDir = path.join(tempStateDir, ".agent", "skills", "my-migrated-skill");
    fs.mkdirSync(path.join(legacyDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: my-migrated-skill\ndescription: Migrated\n---\n# Migrated\n", "utf8");
    fs.writeFileSync(path.join(legacyDir, "scripts", "run.sh"), "echo test", "utf8");

    const result = migrateLegacyStateSkills({
      stateDir: tempStateDir,
      globalSkillsDir: tempGlobalSkillsDir,
    });

    assert.deepEqual(result.migrated, ["my-migrated-skill"]);
    assert.deepEqual(result.skipped, []);

    // Destination has the skill and contents
    const destSkill = path.join(tempGlobalSkillsDir, "my-migrated-skill");
    assert.ok(fs.existsSync(path.join(destSkill, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(destSkill, "scripts", "run.sh")));

    // Source is preserved (non-destructive)
    assert.ok(fs.existsSync(path.join(legacyDir, "SKILL.md")));
  });

  it("does not overwrite existing destination skill during migration", () => {
    const legacyDir = path.join(tempStateDir, ".agent", "skills", "collision-skill");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: collision-skill\ndescription: Old\n---\nOld content", "utf8");

    const destDir = path.join(tempGlobalSkillsDir, "collision-skill");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "SKILL.md"), "---\nname: collision-skill\ndescription: Existing\n---\nExisting content", "utf8");

    const result = migrateLegacyStateSkills({
      stateDir: tempStateDir,
      globalSkillsDir: tempGlobalSkillsDir,
    });

    assert.deepEqual(result.migrated, []);
    assert.deepEqual(result.skipped, ["collision-skill"]);

    // Destination kept original content
    const destContent = fs.readFileSync(path.join(destDir, "SKILL.md"), "utf8");
    assert.ok(destContent.includes("Existing content"));
  });

  it("runs migration transparently in discoverSkills when enabled", () => {
    const legacyDir = path.join(tempStateDir, ".agent", "skills", "auto-migrated-skill");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: auto-migrated-skill\ndescription: Auto Migrated\n---\n# Body", "utf8");

    delete process.env.ADS_MIGRATE_LEGACY_SKILLS;
    // CODEX_HOME will resolve to tempGlobalParent
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-home-"));
    process.env.CODEX_HOME = codexHome;

    try {
      const skills = discoverSkills(tempWorkspace, "/nonexistent-builtins");
      const found = skills.find((s) => s.name === "auto-migrated-skill");
      assert.ok(found);
      assert.equal(found.source, "global");
      assert.equal(found.location, path.join(codexHome, "skills", "auto-migrated-skill", "SKILL.md"));
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("does not leave partial destination directory when copy fails", () => {
    const legacyDir = path.join(tempStateDir, ".agent", "skills", "fail-skill");
    fs.mkdirSync(path.join(legacyDir, "unreadable-dir"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: fail-skill\ndescription: Fail\n---\n# Fail", "utf8");
    fs.writeFileSync(path.join(legacyDir, "unreadable-dir", "secret.txt"), "hidden", "utf8");

    // Make the inner file unreadable to trigger an error during recursive copy
    fs.chmodSync(path.join(legacyDir, "unreadable-dir", "secret.txt"), 0o000);

    try {
      const result = migrateLegacyStateSkills({
        stateDir: tempStateDir,
        globalSkillsDir: tempGlobalSkillsDir,
      });

      // fail-skill should NOT be counted as migrated
      assert.ok(!result.migrated.includes("fail-skill"));

      // The target destination must NOT exist (no partial destination directory)
      const destSkillDir = path.join(tempGlobalSkillsDir, "fail-skill");
      assert.equal(fs.existsSync(destSkillDir), false);

      // No staging directory should remain under tempGlobalSkillsDir
      const remaining = fs.readdirSync(tempGlobalSkillsDir);
      assert.equal(remaining.some((name) => name.startsWith(".staging-")), false);
    } finally {
      // Restore permissions for cleanup
      try {
        fs.chmodSync(path.join(legacyDir, "unreadable-dir", "secret.txt"), 0o644);
      } catch {
        // ignore
      }
    }
  });

  it("CLI runner migrates skills with explicit arguments", () => {
    const customSrc = fs.mkdtempSync(path.join(os.tmpdir(), "ads-custom-src-"));
    const customDest = fs.mkdtempSync(path.join(os.tmpdir(), "ads-custom-dest-"));
    try {
      const legacyDir = path.join(customSrc, ".agent", "skills", "cli-skill");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: cli-skill\ndescription: CLI\n---\n# CLI", "utf8");

      const res = runMigrationCli(["--source", customSrc, "--dest", customDest]);
      assert.deepEqual(res.migrated, ["cli-skill"]);
      assert.ok(fs.existsSync(path.join(customDest, "cli-skill", "SKILL.md")));
    } finally {
      fs.rmSync(customSrc, { recursive: true, force: true });
      fs.rmSync(customDest, { recursive: true, force: true });
    }
  });
});
