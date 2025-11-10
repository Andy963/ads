import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkWorkspaceInit } from '../../src/telegram/utils/workspaceInitChecker.js';

describe("WorkspaceInitChecker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "ads-workspace-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns initialized when required artifacts exist", () => {
    const adsDir = path.join(tempDir, ".ads");
    const templatesDir = path.join(adsDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(adsDir, "workspace.json"), "{}");
    fs.writeFileSync(path.join(templatesDir, "instructions.md"), "# Instructions");

    const status = checkWorkspaceInit(tempDir);

    assert.strictEqual(status.initialized, true);
    assert.strictEqual(status.missingArtifact, undefined);
  });

  it("detects missing workspace.json", () => {
    const status = checkWorkspaceInit(tempDir);

    assert.strictEqual(status.initialized, false);
    assert.strictEqual(status.missingArtifact, ".ads/workspace.json");
  });

  it("detects missing instructions template", () => {
    const adsDir = path.join(tempDir, ".ads");
    fs.mkdirSync(adsDir, { recursive: true });
    fs.writeFileSync(path.join(adsDir, "workspace.json"), "{}");

    const status = checkWorkspaceInit(tempDir);

    assert.strictEqual(status.initialized, false);
    assert.strictEqual(status.missingArtifact, ".ads/templates/instructions.md");
  });
});
