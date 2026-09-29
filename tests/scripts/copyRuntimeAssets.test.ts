import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptSourcePath = path.join(repoRoot, "scripts", "copy-runtime-assets.js");

type TempFixture = {
  root: string;
  scriptPath: string;
};

describe("scripts/copy-runtime-assets", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeFixture(): TempFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-copy-runtime-assets-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    const scriptDir = path.join(root, "scripts");
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "copy-runtime-assets.js");
    fs.copyFileSync(scriptSourcePath, scriptPath);
    return { root, scriptPath };
  }

  function writeBuiltinSkill(root: string, options: { skillMarkdown?: string; withScript?: boolean; withCompiledScript?: boolean } = {}): void {
    const skillDir = path.join(root, "server", "skills", "builtin", "skill-creator");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    if (options.skillMarkdown !== undefined) {
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), options.skillMarkdown, "utf8");
    }
    if (options.withScript !== false) {
      fs.writeFileSync(path.join(skillDir, "scripts", "init-skill.ts"), "export const init = 1;\n", "utf8");
    }
    if (options.withCompiledScript !== false) {
      const compiledDir = path.join(root, "dist", "server", "skills", "builtin", "skill-creator", "scripts");
      fs.mkdirSync(compiledDir, { recursive: true });
      fs.writeFileSync(path.join(compiledDir, "init-skill.js"), "export const init = 1;\n", "utf8");
    }
  }

  function runScript(scriptPath: string, cwd: string) {
    return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
  }

  it("copies builtin skill markdown and validates the compiled scripts", () => {
    const { root, scriptPath } = makeFixture();
    writeBuiltinSkill(root, { skillMarkdown: "# Skill Creator\n\nBody.\n" });

    const result = runScript(scriptPath, root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Builtin skill assets copied.*\(1 files, validated\)/);

    const copied = path.join(root, "dist", "server", "skills", "builtin", "skill-creator", "SKILL.md");
    assert.equal(fs.readFileSync(copied, "utf8"), "# Skill Creator\n\nBody.\n");
    // The compiled script was produced by tsc, not by the asset copy.
    assert.ok(fs.existsSync(path.join(root, "dist", "server", "skills", "builtin", "skill-creator", "scripts", "init-skill.js")));
  });

  it("fails when a builtin skill has no SKILL.md", () => {
    const { root, scriptPath } = makeFixture();
    writeBuiltinSkill(root, { skillMarkdown: undefined });

    const result = runScript(scriptPath, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skill-creator: missing or empty SKILL\.md/);
  });

  it("fails when a builtin SKILL.md is empty", () => {
    const { root, scriptPath } = makeFixture();
    writeBuiltinSkill(root, { skillMarkdown: "" });

    const result = runScript(scriptPath, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing or empty SKILL\.md/);
  });

  it("fails when a compiled skill script is missing from dist", () => {
    const { root, scriptPath } = makeFixture();
    writeBuiltinSkill(root, { skillMarkdown: "# Skill\n", withCompiledScript: false });

    const result = runScript(scriptPath, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/init-skill\.ts: compiled script missing in dist/);
  });

  it("fails when the builtin skills tree is absent", () => {
    const { root, scriptPath } = makeFixture();

    const result = runScript(scriptPath, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Required builtin skills not found/);
  });
});
