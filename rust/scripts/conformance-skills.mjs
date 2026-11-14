#!/usr/bin/env node
/**
 * Cross-implementation conformance for ads.skill.* command handling.
 *
 * Runs the TypeScript command router and the Rust command-line entrypoint over
 * the same isolated skill fixtures, then compares results and created files.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");

const VALID_SKILL = `---
name: valid-skill
description: Valid skill body
version: 2
provides: [demo]
priority: 42
platforms: [linux]
required_env:
  - name: DEMO_TOKEN
    prompt: Provide token
    secret: false
triggers:
  keywords: [demo]
  intents: [run-demo]
entrypoints:
  - cmd: demo
    script: scripts/demo.sh
    args_template: ["--flag"]
    description: Demo entrypoint
---
# Valid Skill

Body line.
`;

const LEGACY_SKILL = `---
name: legacy-skill
description: Legacy skill body
---
# Legacy Skill
`;

const HIDDEN_SKILL = `---
name: hidden-skill
description: Hidden skill body
---
# Hidden Skill
`;

const METADATA = `mode: whitelist
skills:
  valid-skill:
    enabled: true
    priority: 7
  legacy-skill:
    enabled: true
  hidden-skill:
    enabled: false
`;

function seedSkillHome(home) {
  const skillsDir = path.join(home, "skills");
  const writeSkill = (name, content) => {
    const directory = path.join(skillsDir, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), content, "utf8");
  };
  writeSkill("valid-skill", VALID_SKILL);
  writeSkill("legacy-skill", LEGACY_SKILL);
  writeSkill("hidden-skill", HIDDEN_SKILL);
  fs.writeFileSync(path.join(skillsDir, "metadata.yaml"), METADATA, "utf8");
}

function snapshotTree(directory) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = fs.statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      entries.push({
        path: relative,
        mode: stats.mode & 0o777,
        content: fs.readFileSync(absolute, "utf8"),
      });
    }
  };
  if (fs.existsSync(directory)) {
    walk(directory, "");
  }
  return entries;
}

function runFixture(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    input: `${COMMANDS.join("\n")}\n`,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.error ?? result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalize(value, replacements) {
  let output = value;
  for (const [from, to] of replacements) {
    output = output.split(from).join(to);
  }
  return output;
}

const COMMANDS = [
  "/ads.skill.list",
  "/ads.skill.load valid-skill",
  "/ads.skill.load legacy-skill",
  "/ads.skill.load MISSING",
  "/ads.skill.load",
  "/ads.skill.validate valid-skill",
  "/ads.skill.validate legacy-skill",
  "/ads.skill.validate hidden-skill",
  "/ads.skill.validate no-such-skill",
  "/ads.skill.validate",
  "/ads.skill.init My New Skill --resources=scripts,assets --examples=true",
  "/ads.skill.init My New Skill",
  "/ads.skill.init Bad Skill --resources=bogus",
  "/ads.skill.init",
  "/ads.skill.init --resources=scripts",
];

function main() {
  const nodeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ads-node-codex-")));
  const rustHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ads-rust-codex-")));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-workspace-")));
  const nodeState = fs.mkdtempSync(path.join(os.tmpdir(), "ads-node-skill-state-"));
  const rustState = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rust-skill-state-"));
  seedSkillHome(nodeHome);
  seedSkillHome(rustHome);

  try {
    const cargo = process.env.CARGO ?? path.join(os.homedir(), ".cargo", "bin", "cargo");
    const build = spawnSync(cargo, ["build", "-q", "-p", "ads-http", "--example", "command_line"], {
      cwd: rustDir,
      env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
      encoding: "utf8",
    });
    assert(
      build.status === 0,
      `cargo build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    );

    const sharedEnv = { ADS_MIGRATE_LEGACY_SKILLS: "0" };
    const nodeResults = runFixture(
      process.execPath,
      ["--import", "tsx", path.join(scriptDir, "skill-command-fixture.ts"), workspace],
      {
        cwd: root,
        env: {
          ...process.env,
          ...sharedEnv,
          CODEX_HOME: nodeHome,
          ADS_STATE_DIR: nodeState,
        },
      },
    );
    const rustResults = runFixture(
      path.join(rustDir, "target", "debug", "examples", "command_line"),
      [workspace],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ...sharedEnv,
          CODEX_HOME: rustHome,
          ADS_STATE_DIR: rustState,
        },
      },
    );

    assert(
      nodeResults.length === COMMANDS.length && rustResults.length === COMMANDS.length,
      `result counts differ: node=${nodeResults.length} rust=${rustResults.length}`,
    );

    const nodeReplacements = [
      [nodeHome, "<CODEX_HOME>"],
      [workspace, "<WORKSPACE>"],
    ];
    const rustReplacements = [
      [rustHome, "<CODEX_HOME>"],
      [workspace, "<WORKSPACE>"],
    ];

    COMMANDS.forEach((command, index) => {
      const node = nodeResults[index];
      const rust = rustResults[index];
      assert(node.ok === rust.ok, `${command}: ok node=${node.ok} rust=${rust.ok}`);
      const nodeOutput = normalize(node.output, nodeReplacements);
      const rustOutput = normalize(rust.output, rustReplacements);
      assert(
        nodeOutput === rustOutput,
        `${command}: output differs\nnode=${JSON.stringify(nodeOutput)}\nrust=${JSON.stringify(rustOutput)}`,
      );
    });

    const byCommand = new Map(COMMANDS.map((command, index) => [command, nodeResults[index]]));
    const list = byCommand.get("/ads.skill.list").output;
    assert(list.includes("valid-skill"), "list is missing valid-skill");
    assert(list.includes("legacy-skill"), "list is missing legacy-skill");
    assert(!list.includes("hidden-skill"), "whitelist-disabled skill should not be listed");
    assert(
      byCommand.get("/ads.skill.load valid-skill").output.includes("# Valid Skill"),
      "load did not return the skill body",
    );
    assert(
      byCommand.get("/ads.skill.load MISSING").output.startsWith('❌ Skill "MISSING" 未找到。'),
      "missing skill output drifted",
    );
    assert(
      byCommand.get("/ads.skill.validate valid-skill").output ===
        "✅ Skill is valid!\n目录: valid-skill",
      "valid skill validation output drifted",
    );
    assert(
      byCommand.get("/ads.skill.validate no-such-skill").output ===
        "❌ SKILL.md not found\n目录: no-such-skill",
      "missing skill validation output drifted",
    );
    assert(
      byCommand.get("/ads.skill.init Bad Skill --resources=bogus").output ===
        "Unknown resource type(s): bogus. Allowed: assets, references, scripts",
      "invalid resource output drifted",
    );
    assert(
      byCommand.get("/ads.skill.init").output === "❌ Missing skill name",
      "missing init name output drifted",
    );

    const nodeTree = snapshotTree(path.join(nodeHome, "skills", "my-new-skill"));
    const rustTree = snapshotTree(path.join(rustHome, "skills", "my-new-skill"));
    assert(nodeTree.length > 0, "node init did not create the skill");
    assert(
      JSON.stringify(nodeTree) === JSON.stringify(rustTree),
      `created skill trees differ\nnode=${JSON.stringify(nodeTree)}\nrust=${JSON.stringify(rustTree)}`,
    );
    assert(
      nodeTree.some((entry) => entry.path === "scripts/example.py" && entry.mode === 0o755),
      "init did not create an executable example script",
    );

    console.log("ok: skill command conformance");
  } finally {
    for (const directory of [nodeHome, rustHome, workspace, nodeState, rustState]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

main();
