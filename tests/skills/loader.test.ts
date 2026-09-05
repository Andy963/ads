import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  discoverSkills,
  getSkillFileCacheSizeForTests,
  loadSkillBody,
  renderCompactSkills,
  renderSkillMetaInstruction,
  resetSkillFileCacheForTests,
  type SkillMetadata,
} from "../../server/skills/loader.js";
import { resolveGlobalSkillsDir } from "../../server/skills/paths.js";

let workspaceRoot: string;
let adsStateDir: string;
let codexHomeDir: string;
let originalEnv: NodeJS.ProcessEnv;
const NO_BUILTINS = "/nonexistent-builtin-root";

function createGlobalSkill(name: string, frontmatter: string): void {
  const dir = path.join(resolveGlobalSkillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter, "utf-8");
}

describe("skills/loader", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-workspace-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-state-"));
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-codex-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    process.env.CODEX_HOME = codexHomeDir;
    process.env.ADS_MIGRATE_LEGACY_SKILLS = "0";
    resetSkillFileCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSkillFileCacheForTests();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it("discovers skills from global Codex skills directory by default", () => {
    createGlobalSkill("my-skill", [
      "---",
      "name: my-skill",
      "description: A test skill",
      "---",
      "# My Skill",
      "Body content here.",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "global" && s.name === "my-skill");
    assert.ok(skill);
    assert.equal(skill.description, "A test skill");
  });

  it("skips directories without SKILL.md", () => {
    const dir = path.join(resolveGlobalSkillsDir(), "no-skill-md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill", "utf-8");

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const found = skills.find((s) => s.name === "no-skill-md") ?? null;
    assert.equal(found, null);
  });

  it("uses directory name when frontmatter has no name", () => {
    createGlobalSkill("fallback-name", [
      "---",
      "description: No name field",
      "---",
      "Body.",
    ].join("\n"));

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "global" && s.name === "fallback-name");
    assert.ok(skill);
  });

  it("handles missing frontmatter gracefully", () => {
    createGlobalSkill("no-front", "# Just markdown\nNo frontmatter.");

    const skills = discoverSkills(workspaceRoot, NO_BUILTINS);
    const skill = skills.find((s) => s.source === "global" && s.name === "no-front");
    assert.ok(skill);
    assert.equal(skill.description, "No description provided.");
  });

  it("global skills take precedence over builtin skills with same name", () => {
    const skillName = `dup-skill-${Date.now()}`;
    createGlobalSkill(skillName, [
      "---",
      `name: ${skillName}`,
      "description: global version",
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
    assert.equal(skill.description, "global version");
    assert.equal(skill.source, "global");
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
    createGlobalSkill(skillName, content);

    const body = loadSkillBody(skillName, workspaceRoot, NO_BUILTINS);
    assert.equal(body, content);
  });

  it("loadSkillBody returns null for unknown skill", () => {
    const body = loadSkillBody("nonexistent", workspaceRoot, NO_BUILTINS);
    assert.equal(body, null);
  });

  it("removes stale cache entries after a discovered skill file is deleted", () => {
    createGlobalSkill("ephemeral-skill", [
      "---",
      "name: ephemeral-skill",
      "description: Temporary skill",
      "---",
      "Body",
    ].join("\n"));

    const firstSkills = discoverSkills(workspaceRoot, NO_BUILTINS);
    assert.ok(firstSkills.some((skill) => skill.name === "ephemeral-skill"));
    assert.equal(loadSkillBody("ephemeral-skill", workspaceRoot, NO_BUILTINS) != null, true);
    const cacheSizeBeforeDelete = getSkillFileCacheSizeForTests();
    assert.ok(cacheSizeBeforeDelete >= 1);

    fs.rmSync(path.join(resolveGlobalSkillsDir(), "ephemeral-skill"), { recursive: true, force: true });

    const secondSkills = discoverSkills(workspaceRoot, NO_BUILTINS);
    assert.equal(secondSkills.some((skill) => skill.name === "ephemeral-skill"), false);
    assert.equal(loadSkillBody("ephemeral-skill", workspaceRoot, NO_BUILTINS), null);
    assert.equal(getSkillFileCacheSizeForTests(), cacheSizeBeforeDelete - 1);
  });

  it("renderCompactSkills formats skills as XML", () => {
    const skills: SkillMetadata[] = [
      makeSkillMeta("alpha", "First skill", "/tmp/a", "builtin"),
      makeSkillMeta("beta", "Second skill", "/tmp/b", "global"),
    ];
    const output = renderCompactSkills(skills);
    assert.ok(output.includes("<available_skills>"));
    assert.ok(output.includes('name="alpha"'));
    assert.ok(output.includes('name="beta"'));
    assert.ok(output.includes('source="builtin"'));
    assert.ok(output.includes('source="global"'));
    assert.ok(output.includes("First skill"));
  });

  it("tells agents to execute auto-loaded skills without searching for them", () => {
    const output = renderSkillMetaInstruction([
      makeSkillMeta("alpha", "First skill", "/tmp/a", "global"),
    ]);

    assert.match(output, /自动加载匹配 skill/);
    assert.match(output, /不得为了寻找已经注入的 skill/);
  });

  it("loads SKILL.md v1 frontmatter fields", () => {
    createGlobalSkill("v1-skill", [
      "---",
      "name: v1-skill",
      "description: A v1 skill",
      "version: 1",
      "provides: [audio.transcribe]",
      "priority: 7",
      "platforms: [linux]",
      "required_env:",
      "  - name: API_KEY",
      "    secret: true",
      "triggers:",
      "  keywords: [audio]",
      "  intents: [transcribe]",
      "entrypoints:",
      "  - cmd: node",
      "    args_template: [script.js]",
      "---",
      "Body",
    ].join("\n"));

    const skill = discoverSkills(workspaceRoot, NO_BUILTINS).find((s) => s.name === "v1-skill");
    assert.ok(skill);
    assert.deepEqual(skill.provides, ["audio.transcribe"]);
    assert.equal(skill.priority, 7);
    assert.deepEqual(skill.platforms, ["linux"]);
    assert.equal(skill.requiredEnv[0]?.name, "API_KEY");
    assert.deepEqual(skill.triggers.keywords, ["audio"]);
    assert.equal(skill.entrypoints[0]?.cmd, "node");
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
    createGlobalSkill(`${prefix}zeta`, `---\nname: ${prefix}zeta\ndescription: z\n---`);
    createGlobalSkill(`${prefix}alpha`, `---\nname: ${prefix}alpha\ndescription: a\n---`);
    createGlobalSkill(`${prefix}mid`, `---\nname: ${prefix}mid\ndescription: m\n---`);

    const sorted = discoverSkills(workspaceRoot, NO_BUILTINS)
      .filter((s) => s.name.startsWith(prefix))
      .map((s) => s.name);
    assert.deepEqual(sorted, [`${prefix}alpha`, `${prefix}mid`, `${prefix}zeta`]);
  });
});

function makeSkillMeta(
  name: string,
  description: string,
  location: string,
  source: SkillMetadata["source"],
): SkillMetadata {
  return {
    name,
    description,
    location,
    source,
    version: 1,
    provides: [],
    priority: 100,
    platforms: ["linux", "macos", "win32"],
    requiredEnv: [],
    triggers: { keywords: [], intents: [] },
    entrypoints: [],
    deprecated: false,
  };
}
