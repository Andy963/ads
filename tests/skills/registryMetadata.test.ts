import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSkillRegistry } from "../../src/skills/registryMetadata.js";

function writeRegistry(root: string, yamlBody: string): void {
  const dir = path.join(root, ".agent", "skills");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.yaml"), yamlBody, "utf8");
}

describe("skills/registryMetadata workspace overlay", () => {
  let workspaceRoot: string;
  let adsStateDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-workspace-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-state-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    delete process.env.ADS_ENABLE_WORKSPACE_SKILLS;
    delete process.env.ADS_SKILLS_METADATA_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
  });

  it("overlays workspace metadata.yaml on top of state metadata.yaml", () => {
    writeRegistry(adsStateDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  demo-skill:",
      "    provides: [demo]",
      "    priority: 1",
      "",
    ].join("\n"));

    writeRegistry(workspaceRoot, [
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

