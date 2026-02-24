import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverSkills, loadSkillBody, renderCompactSkills, type SkillMetadata } from "../../src/skills/loader.js";

let workspaceRoot: string;
let adsStateDir: string;
let originalEnv: NodeJS.ProcessEnv;
const NO_BUILTINS = "/nonexistent-builtin-root";

function createSkill(root: string, name: string, frontmatter: string): void {
  const dir = path.join(root, ".agent", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter, "utf-8");
}

function writeWorkspaceSkillsMetadata(workspaceRoot: string): void {
  const dir = path.join(workspaceRoot, ".agent", "skills");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.yaml"),
    ["version: 1", "mode: overlay", "skills: {}", ""].join("\n"),
    "utf8",
  );
}

describe("skills/loader", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-workspace-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-state-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    delete process.env.ADS_ENABLE_WORKSPACE_SKILLS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
  });

  it("discovers skills from ADS state store by default", () => {
    createSkill(adsStateDir, "my-skill", [
      "---",
      "name: my-skill",
      "description: A test skill",
      "---",
      "# My Skill",
      "Body content here.",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "state" && s.name === "my-skill");
    assert.ok(skill);
    assert.equal(skill.description, "A test skill");
  });

  it("ignores workspace .agent/skills by default", () => {
    const skillName = `workspace-only-${Date.now()}`;
    createSkill(workspaceRoot, skillName, [
      "---",
      `name: ${skillName}`,
      "description: Workspace skill",
      "---",
      "# Workspace Skill",
      "Body",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const found = skills.find((s) => s.name === skillName) ?? null;
    assert.equal(found, null);
  });

  it("auto-enables workspace .agent/skills when metadata.yaml exists", () => {
    writeWorkspaceSkillsMetadata(workspaceRoot);
    const skillName = `workspace-meta-${Date.now()}`;
    createSkill(workspaceRoot, skillName, [
      "---",
      `name: ${skillName}`,
      "description: Workspace skill",
      "---",
      "# Workspace Skill",
      "Body",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const found = skills.find((s) => s.name === skillName) ?? null;
    assert.ok(found);
    assert.equal(found.source, "workspace");
  });

  it("skips directories without SKILL.md", () => {
    const dir = path.join(adsStateDir, ".agent", "skills", "no-skill-md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill", "utf-8");

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const found = skills.find((s) => s.name === "no-skill-md") ?? null;
    assert.equal(found, null);
  });

  it("uses directory name when frontmatter has no name", () => {
    createSkill(adsStateDir, "fallback-name", [
      "---",
      "description: No name field",
      "---",
      "Body.",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "state" && s.name === "fallback-name");
    assert.ok(skill);
  });

  it("handles missing frontmatter gracefully", () => {
    createSkill(adsStateDir, "no-front", "# Just markdown\nNo frontmatter.");

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "state" && s.name === "no-front");
    assert.ok(skill);
    assert.equal(skill.description, "No description provided.");
  });

  it("state skills take precedence over builtin skills with same name", () => {
    const skillName = `dup-skill-${Date.now()}`;
    createSkill(adsStateDir, skillName, [
      "---",
      `name: ${skillName}`,
      "description: state version",
      "---",
    ].join("\n"));

    const builtinRoot = path.join(workspaceRoot, "builtins");
    const builtinDir = path.join(builtinRoot, skillName);
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: builtin version",
      "---",
    ].join("\n"), "utf-8");

    const skills = discoverSkills(workspaceRoot, builtinRoot);
    const skill = skills.find((s) => s.name === skillName);
    assert.ok(skill);
    assert.equal(skill.description, "state version");
    assert.equal(skill.source, "state");
  });

  it("discovers workspace skills when ADS_ENABLE_WORKSPACE_SKILLS=1", () => {
    process.env.ADS_ENABLE_WORKSPACE_SKILLS = "1";
    const skillName = `ws-skill-${Date.now()}`;
    createSkill(workspaceRoot, skillName, [
      "---",
      `name: ${skillName}`,
      "description: workspace version",
      "---",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.name === skillName);
    assert.ok(skill);
    assert.equal(skill.source, "workspace");
    assert.equal(skill.description, "workspace version");
  });

  it("workspace skills take precedence over state skills when enabled", () => {
    process.env.ADS_ENABLE_WORKSPACE_SKILLS = "1";
    const skillName = `ws-over-state-${Date.now()}`;

    createSkill(adsStateDir, skillName, ["---", `name: ${skillName}`, "description: state version", "---"].join("\n"));
    createSkill(workspaceRoot, skillName, ["---", `name: ${skillName}`, "description: workspace version", "---"].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.name === skillName);
    assert.ok(skill);
    assert.equal(skill.source, "workspace");
    assert.equal(skill.description, "workspace version");
  });

  it("discovers builtin skills", () => {
    const skillName = `builtin-skill-${Date.now()}`;
    const builtinRoot = path.join(workspaceRoot, "builtins");
    const builtinDir = path.join(builtinRoot, skillName);
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: A builtin",
      "---",
    ].join("\n"), "utf-8");

    const skills = discoverSkills(workspaceRoot, builtinRoot);
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
    createSkill(adsStateDir, skillName, content);

    const body = loadSkillBody(skillName, workspaceRoot, NO_BUILTINS);
    assert.equal(body, content);
  });

  it("loadSkillBody returns null for unknown skill", () => {
    const body = loadSkillBody("nonexistent", workspaceRoot, NO_BUILTINS);
    assert.equal(body, null);
  });

  it("renderCompactSkills formats skills as XML", () => {
    const skills: SkillMetadata[] = [
      { name: "alpha", description: "First skill", location: "/tmp/a", source: "state" },
      { name: "beta", description: "Second skill", location: "/tmp/b", source: "global" },
    ];
    const output = renderCompactSkills(skills);
    assert.ok(output.includes("<available_skills>"));
    assert.ok(output.includes('name="alpha"'));
    assert.ok(output.includes('name="beta"'));
    assert.ok(output.includes('source="state"'));
    assert.ok(output.includes('source="global"'));
    assert.ok(output.includes("First skill"));
  });

  it("renderCompactSkills returns empty string for no skills", () => {
    assert.equal(renderCompactSkills([]), "");
  });

  it("discovers builtin skill-creator by default", () => {
    const skills = discoverSkills(workspaceRoot);
    const creator = skills.find((s) => s.name === "skill-creator");
    assert.ok(creator, "skill-creator should be discovered");
    assert.equal(creator.source, "builtin");
  });

  it("sorts discovered skills alphabetically", () => {
    const prefix = `sort-${Date.now()}-`;
    createSkill(adsStateDir, `${prefix}zeta`, `---\nname: ${prefix}zeta\ndescription: z\n---`);
    createSkill(adsStateDir, `${prefix}alpha`, `---\nname: ${prefix}alpha\ndescription: a\n---`);
    createSkill(adsStateDir, `${prefix}mid`, `---\nname: ${prefix}mid\ndescription: m\n---`);

    const sorted = discoverSkills(workspaceRoot, NO_BUILTINS)
      .filter((s) => s.name.startsWith(prefix))
      .map((s) => s.name);
    assert.deepEqual(sorted, [`${prefix}alpha`, `${prefix}mid`, `${prefix}zeta`]);
  });
});
