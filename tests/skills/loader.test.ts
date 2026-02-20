import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverSkills, loadSkillBody, renderCompactSkills, type SkillMetadata } from "../../src/skills/loader.js";

let tmpDir: string;
const NO_BUILTINS = "/nonexistent-builtin-root";

function createSkill(root: string, name: string, frontmatter: string): void {
  const dir = path.join(root, ".agent", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter, "utf-8");
}

describe("skills/loader", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers skills from workspace .agent/skills", () => {
    createSkill(tmpDir, "my-skill", [
      "---",
      "name: my-skill",
      "description: A test skill",
      "---",
      "# My Skill",
      "Body content here.",
    ].join("\n"));

    const skills = discoverSkills(tmpDir, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "project" && s.name === "my-skill");
    assert.ok(skill);
    assert.equal(skill.description, "A test skill");
  });

  it("returns empty when no skills directory exists", () => {
    const skills = discoverSkills(tmpDir, NO_BUILTINS);
    assert.equal(skills.filter((s) => s.source === "project").length, 0);
  });

  it("skips directories without SKILL.md", () => {
    const dir = path.join(tmpDir, ".agent", "skills", "no-skill-md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill", "utf-8");

    const skills = discoverSkills(tmpDir, NO_BUILTINS);
    assert.equal(skills.filter((s) => s.source === "project").length, 0);
  });

  it("uses directory name when frontmatter has no name", () => {
    createSkill(tmpDir, "fallback-name", [
      "---",
      "description: No name field",
      "---",
      "Body.",
    ].join("\n"));

    const skills = discoverSkills(tmpDir, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "project" && s.name === "fallback-name");
    assert.ok(skill);
  });

  it("handles missing frontmatter gracefully", () => {
    createSkill(tmpDir, "no-front", "# Just markdown\nNo frontmatter.");

    const skills = discoverSkills(tmpDir, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "project" && s.name === "no-front");
    assert.ok(skill);
    assert.equal(skill.description, "No description provided.");
  });

  it("project skills take precedence over builtin skills with same name", () => {
    const skillName = `dup-skill-${Date.now()}`;
    createSkill(tmpDir, skillName, [
      "---",
      `name: ${skillName}`,
      "description: project version",
      "---",
    ].join("\n"));

    const builtinRoot = path.join(tmpDir, "builtins");
    const builtinDir = path.join(builtinRoot, skillName);
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: builtin version",
      "---",
    ].join("\n"), "utf-8");

    const skills = discoverSkills(tmpDir, builtinRoot);
    const skill = skills.find((s) => s.name === skillName);
    assert.ok(skill);
    assert.equal(skill.description, "project version");
    assert.equal(skill.source, "project");
  });

  it("discovers builtin skills", () => {
    const skillName = `builtin-skill-${Date.now()}`;
    const builtinRoot = path.join(tmpDir, "builtins");
    const builtinDir = path.join(builtinRoot, skillName);
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: A builtin",
      "---",
    ].join("\n"), "utf-8");

    const skills = discoverSkills(tmpDir, builtinRoot);
    const skill = skills.find((s) => s.source === "builtin" && s.name === skillName);
    assert.ok(skill);
  });

  it("loadSkillBody returns full file content", () => {
    const skillName = `read-me-${Date.now()}`;
    const content = [
      "---",
      `name: ${skillName}`,
      "description: Readable",
      "---",
      "# Body",
      "Some instructions.",
    ].join("\n");
    createSkill(tmpDir, skillName, content);

    const body = loadSkillBody(skillName, tmpDir, NO_BUILTINS);
    assert.equal(body, content);
  });

  it("loadSkillBody returns null for unknown skill", () => {
    const body = loadSkillBody("nonexistent", tmpDir, NO_BUILTINS);
    assert.equal(body, null);
  });

  it("renderCompactSkills formats skills as XML", () => {
    const skills: SkillMetadata[] = [
      { name: "alpha", description: "First skill", location: "/tmp/a", source: "project" },
      { name: "beta", description: "Second skill", location: "/tmp/b", source: "global" },
    ];
    const output = renderCompactSkills(skills);
    assert.ok(output.includes("<available_skills>"));
    assert.ok(output.includes('name="alpha"'));
    assert.ok(output.includes('name="beta"'));
    assert.ok(output.includes('source="project"'));
    assert.ok(output.includes('source="global"'));
    assert.ok(output.includes("First skill"));
  });

  it("renderCompactSkills returns empty string for no skills", () => {
    assert.equal(renderCompactSkills([]), "");
  });

  it("discovers builtin skill-creator by default", () => {
    const skills = discoverSkills(tmpDir);
    const creator = skills.find((s) => s.name === "skill-creator");
    assert.ok(creator, "skill-creator should be discovered");
    assert.equal(creator.source, "builtin");
  });

  it("sorts discovered skills alphabetically", () => {
    createSkill(tmpDir, "zeta", "---\nname: zeta\ndescription: z\n---");
    createSkill(tmpDir, "alpha", "---\nname: alpha\ndescription: a\n---");
    createSkill(tmpDir, "mid", "---\nname: mid\ndescription: m\n---");

    const skills = discoverSkills(tmpDir, NO_BUILTINS).filter((s) => s.source === "project");
    assert.deepEqual(skills.map((s) => s.name), ["alpha", "mid", "zeta"]);
  });
});
