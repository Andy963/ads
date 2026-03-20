import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptSourcePath = path.join(repoRoot, "scripts", "copy-runtime-assets.js");

const requiredTemplateFiles = [
  "instructions.md",
  "rules.md",
  "supervisor.md",
  "requirement.md",
  "design.md",
  "implementation.md",
  "task.md",
];

describe("scripts/copy-runtime-assets", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("copies templates without expecting removed graph config", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-copy-runtime-assets-"));
    tempDirs.push(tempRoot);

    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const tempScriptDir = path.join(tempRoot, "scripts");
    const tempTemplatesDir = path.join(tempRoot, "templates");
    fs.mkdirSync(tempScriptDir, { recursive: true });
    fs.mkdirSync(tempTemplatesDir, { recursive: true });
    fs.mkdirSync(path.join(tempTemplatesDir, "skills"), { recursive: true });

    const scriptSource = fs.readFileSync(scriptSourcePath, "utf8");
    fs.writeFileSync(path.join(tempScriptDir, "copy-runtime-assets.js"), scriptSource, "utf8");
    fs.writeFileSync(path.join(tempTemplatesDir, "skills", "README.md"), "skill body", "utf8");

    for (const fileName of requiredTemplateFiles) {
      fs.writeFileSync(path.join(tempTemplatesDir, fileName), `${fileName}\n`, "utf8");
    }

    const output = execFileSync(process.execPath, [path.join(tempScriptDir, "copy-runtime-assets.js")], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.match(output, /\[copy-runtime-assets\] Templates copied to /);
    assert.doesNotMatch(output, /Graph config/);

    const copiedTemplate = path.join(tempRoot, "dist", "templates", "instructions.md");
    assert.equal(fs.readFileSync(copiedTemplate, "utf8"), "instructions.md\n");
    assert.equal(fs.existsSync(path.join(tempRoot, "dist", "templates", "skills", "README.md")), true);
    assert.equal(fs.existsSync(path.join(tempRoot, "dist", "server", "graph")), false);
  });
});
