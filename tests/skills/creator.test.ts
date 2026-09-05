import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initSkill, parseResourceList, saveSkillDraftFromBlock, validateSkillDirectory } from "../../server/skills/creator.js";
import { resolveGlobalSkillsDir } from "../../server/skills/paths.js";

describe("skills/creator", () => {
  let tempCodexHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-creator-codex-"));
    process.env.CODEX_HOME = tempCodexHome;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempCodexHome, { recursive: true, force: true });
  });

  it("initializes a skill under global $CODEX_HOME/skills", () => {
    const created = initSkill({
      rawName: "My Skill",
      resources: ["scripts", "references"],
      includeExamples: true,
    });

    assert.equal(created.skillName, "my-skill");
    assert.equal(path.dirname(created.skillDir), resolveGlobalSkillsDir());
    assert.ok(fs.existsSync(path.join(created.skillDir, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(created.skillDir, "scripts", "example.py")));
    assert.ok(fs.existsSync(path.join(created.skillDir, "references", "api_reference.md")));

    const validated = validateSkillDirectory(created.skillDir);
    assert.equal(validated.valid, true, validated.message);
  });

  it("returns a validation error when SKILL.md is missing", () => {
    const dir = path.join(resolveGlobalSkillsDir(), "missing");
    fs.mkdirSync(dir, { recursive: true });
    const validated = validateSkillDirectory(dir);
    assert.equal(validated.valid, false);
    assert.equal(validated.message, "SKILL.md not found");
  });

  it("rejects unknown resource types", () => {
    assert.throws(() => parseResourceList("scripts,unknown"), /Unknown resource type/);
  });

  it("normalizes the skill name when saving a skill draft", () => {
    const saved = saveSkillDraftFromBlock({
      name: "My Draft Skill",
      description: "Draft description",
      body: "## Overview\n\nSaved content.",
    });

    assert.equal(saved.skillName, "my-draft-skill");
    assert.equal(path.dirname(saved.skillDir), resolveGlobalSkillsDir());
    assert.equal(saved.backupPath, null);
    assert.ok(fs.existsSync(path.join(saved.skillDir, "SKILL.md")));

    const content = fs.readFileSync(path.join(saved.skillDir, "SKILL.md"), "utf8");
    assert.match(content, /name: my-draft-skill/);
    assert.match(content, /description: "Draft description"/);
    assert.match(content, /version: 1/);

    const validated = validateSkillDirectory(saved.skillDir);
    assert.equal(validated.valid, true, validated.message);
  });

  it("restores the previous skill draft when a new body fails validation", () => {
    const saved = saveSkillDraftFromBlock({
      name: "Existing Skill",
      description: "Initial description",
      body: "## Overview\n\nInitial content.",
    });

    const originalContent = fs.readFileSync(saved.skillMdPath, "utf8");

    assert.throws(
      () =>
        saveSkillDraftFromBlock({
          name: "Existing Skill",
          description: "Ignored",
          body: ["---", "name: existing-skill", "---", "", "Broken content"].join("\n"),
        }),
      /Missing 'description' in frontmatter/,
    );

    assert.equal(fs.readFileSync(saved.skillMdPath, "utf8"), originalContent);
    const backupFiles = fs.readdirSync(saved.skillDir).filter((entry) => entry.startsWith("SKILL.md.bak."));
    assert.equal(backupFiles.length, 1);
  });
});
