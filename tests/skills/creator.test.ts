import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initSkill, parseResourceList, validateSkillDirectory } from "../../src/skills/creator.js";

describe("skills/creator", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-creator-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("initializes a skill under workspace .agent/skills", () => {
    const created = initSkill({
      workspaceRoot: workspace,
      rawName: "My Skill",
      resources: ["scripts", "references"],
      includeExamples: true,
    });

    assert.equal(created.skillName, "my-skill");
    assert.ok(fs.existsSync(path.join(created.skillDir, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(created.skillDir, "scripts", "example.py")));
    assert.ok(fs.existsSync(path.join(created.skillDir, "references", "api_reference.md")));

    const validated = validateSkillDirectory(created.skillDir);
    assert.equal(validated.valid, true, validated.message);
  });

  it("returns a validation error when SKILL.md is missing", () => {
    const dir = path.join(workspace, ".agent", "skills", "missing");
    fs.mkdirSync(dir, { recursive: true });
    const validated = validateSkillDirectory(dir);
    assert.equal(validated.valid, false);
    assert.equal(validated.message, "SKILL.md not found");
  });

  it("rejects unknown resource types", () => {
    assert.throws(() => parseResourceList("scripts,unknown"), /Unknown resource type/);
  });
});

