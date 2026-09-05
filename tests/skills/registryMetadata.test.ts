import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSkillRegistry } from "../../server/skills/registryMetadata.js";
import { resolveGlobalSkillsDir } from "../../server/skills/paths.js";

function writeGlobalRegistry(yamlBody: string): void {
  const dir = resolveGlobalSkillsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.yaml"), yamlBody, "utf8");
}

describe("skills/registryMetadata global registry", () => {
  let workspaceRoot: string;
  let adsStateDir: string;
  let codexHomeDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-workspace-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-state-"));
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-codex-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    process.env.CODEX_HOME = codexHomeDir;
    delete process.env.ADS_SKILLS_METADATA_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it("loads global metadata.yaml for skill registry overrides", () => {
    writeGlobalRegistry([
      "version: 1",
      "mode: overlay",
      "skills:",
      "  demo-skill:",
      "    provides: [demo]",
      "    priority: 100",
      "",
    ].join("\n"));

    const registry = loadSkillRegistry(workspaceRoot);
    assert.ok(registry);
    const entry = registry.skills.get("demo-skill");
    assert.ok(entry);
    assert.equal(entry.priority, 100);
    assert.deepEqual(entry.provides, ["demo"]);
  });
});
