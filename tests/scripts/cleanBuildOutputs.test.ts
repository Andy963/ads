import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cleanOwnedOutputs } from "../../scripts/clean-build-outputs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cleanScriptPath = path.join(repoRoot, "scripts", "clean-build-outputs.js");
const copyAssetsSourcePath = path.join(repoRoot, "scripts", "copy-runtime-assets.js");
const tscBinPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

describe("scripts/clean-build-outputs", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(root);
    return root;
  }

  function runClean(root: string, extraArgs: string[] = []) {
    return spawnSync(process.execPath, [cleanScriptPath, "--root", root, ...extraArgs], { encoding: "utf8" });
  }

  function writeSources(root: string, names: string[]): void {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (const name of names) {
      fs.writeFileSync(path.join(root, "src", name), `export const ${path.basename(name, ".ts")} = 1;\n`, "utf8");
    }
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          outDir: "dist/server",
          rootDir: "src",
        },
        include: ["src"],
      }),
      "utf8",
    );
  }

  function runTsc(root: string): void {
    const result = spawnSync(process.execPath, [tscBinPath, "-p", path.join(root, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }

  function buildFixture(root: string): void {
    const clean = runClean(root, ["--paths", "dist"]);
    assert.equal(clean.status, 0, clean.stderr);
    runTsc(root);
  }

  function snapshotOutputs(root: string): Map<string, string> {
    const inventory = new Map<string, string>();
    const distDir = path.join(root, "dist");
    if (!fs.existsSync(distDir)) return inventory;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
          inventory.set(path.relative(root, full), hash);
        }
      }
    };
    walk(distDir);
    return inventory;
  }

  it("removes only owned paths and never touches web, workspace, or untracked files", () => {
    const root = makeTempRoot("ads-clean-owned-");
    for (const rel of [
      "dist/server/tasks/executor.js",
      "dist/shared/terminology.js",
      "dist/templates/planner-instructions.md",
      "dist/client/index.html",
      "untracked-source.txt",
    ]) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "stale\n", "utf8");
    }
    fs.mkdirSync(path.join(root, ".ads"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ads", "state.db"), "workspace data\n", "utf8");

    const result = runClean(root);
    assert.equal(result.status, 0, result.stderr);

    assert.ok(!fs.existsSync(path.join(root, "dist", "server")), "backend output removed");
    assert.ok(!fs.existsSync(path.join(root, "dist", "shared")), "shared output removed");
    assert.ok(!fs.existsSync(path.join(root, "dist", "templates")), "legacy templates removed");
    assert.ok(fs.existsSync(path.join(root, "dist", "client", "index.html")), "web bundle is Vite-owned and preserved");
    assert.ok(fs.existsSync(path.join(root, ".ads", "state.db")), "workspace data preserved");
    assert.ok(fs.existsSync(path.join(root, "untracked-source.txt")), "untracked source preserved");
  });

  it("refuses paths that escape the root or are absolute", () => {
    const root = makeTempRoot("ads-clean-guard-");
    assert.throws(() => cleanOwnedOutputs(root, ["../outside"]), /refusing unsafe owned path/);
    assert.throws(() => cleanOwnedOutputs(root, [path.join(root, "dist")]), /refusing unsafe owned path/);
    assert.throws(() => cleanOwnedOutputs(root, ["."]), /refusing unsafe owned path|escapes root/);
    assert.throws(() => cleanOwnedOutputs(root, ["dist/../../etc"]), /refusing unsafe owned path/);
  });

  it("drops stale outputs from deleted sources and produces identical repeated builds", () => {
    const root = makeTempRoot("ads-clean-rebuild-");
    writeSources(root, ["alpha.ts", "beta.ts"]);

    buildFixture(root);
    const first = snapshotOutputs(root);
    assert.deepEqual([...first.keys()].sort(), ["dist/server/alpha.js", "dist/server/beta.js"]);

    // Plant retired stale outputs, then delete one source file.
    for (const rel of ["dist/server/tasks/executor.js", "dist/server/web/server/taskQueue/runtime.js", "dist/server/agents/cli/cliRunner.js"]) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "stale\n", "utf8");
    }
    fs.rmSync(path.join(root, "src", "beta.ts"));

    buildFixture(root);
    const second = snapshotOutputs(root);
    assert.deepEqual([...second.keys()].sort(), ["dist/server/alpha.js"], "stale and deleted-source outputs are gone");

    buildFixture(root);
    const third = snapshotOutputs(root);
    assert.deepEqual(third, second, "repeated builds at the same revision are identical");
  });

  it("assembled artifacts keep required skill assets and exclude retired outputs", () => {
    const root = makeTempRoot("ads-clean-release-");
    writeSources(root, ["alpha.ts"]);

    // Seed a builtin skill fixture and retired legacy outputs that must not
    // survive cleanup. The compiled skill script is planted after the build,
    // mimicking tsc emit in a real build (the fixture tsc project only covers src/).
    const skillDir = path.join(root, "server", "skills", "builtin", "skill-creator");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill Creator\n", "utf8");
    fs.writeFileSync(path.join(skillDir, "scripts", "init-skill.ts"), "export const init = 1;\n", "utf8");
    for (const rel of ["dist/templates/instructions.md", "dist/server/web/server/taskQueue/runtime.js"]) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "stale\n", "utf8");
    }

    // Full build: clean owned outputs, compile, copy + validate skill assets.
    buildFixture(root);
    const compiledDir = path.join(root, "dist", "server", "skills", "builtin", "skill-creator", "scripts");
    fs.mkdirSync(compiledDir, { recursive: true });
    fs.writeFileSync(path.join(compiledDir, "init-skill.js"), "export const init = 1;\n", "utf8");
    const copyScriptDir = path.join(root, "scripts");
    fs.mkdirSync(copyScriptDir, { recursive: true });
    const copyScriptPath = path.join(copyScriptDir, "copy-runtime-assets.js");
    fs.copyFileSync(copyAssetsSourcePath, copyScriptPath);
    const copyResult = spawnSync(process.execPath, [copyScriptPath], { cwd: root, encoding: "utf8" });
    assert.equal(copyResult.status, 0, copyResult.stderr);

    // Assemble a release the same way deploy-local does: copy the whole dist.
    const staging = path.join(root, "staging");
    fs.cpSync(path.join(root, "dist"), path.join(staging, "dist"), { recursive: true });

    assert.ok(fs.existsSync(path.join(staging, "dist", "server", "skills", "builtin", "skill-creator", "SKILL.md")), "builtin SKILL.md ships");
    assert.ok(
      fs.existsSync(path.join(staging, "dist", "server", "skills", "builtin", "skill-creator", "scripts", "init-skill.js")),
      "compiled skill script ships",
    );
    assert.ok(!fs.existsSync(path.join(staging, "dist", "templates")), "legacy templates absent from release");
    assert.ok(!fs.existsSync(path.join(staging, "dist", "server", "web", "server", "taskQueue", "runtime.js")), "retired TaskQueue output absent");
  });
});
