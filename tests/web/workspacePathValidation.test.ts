import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getProjectPathValidationErrorMessage,
  resolveWorkspaceRootFromDirectory,
  validateWorkspacePath,
} from "../../server/web/server/api/routes/workspacePath.js";

describe("web/workspacePath validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-path-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns missing_path for blank input", () => {
    const result = validateWorkspacePath({
      candidatePath: " ",
      allowedDirs: [tmpDir],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "missing_path");
      assert.equal(getProjectPathValidationErrorMessage(result.reason), "path is required");
    }
  });

  it("returns not_allowed for paths outside allow list", () => {
    const result = validateWorkspacePath({
      candidatePath: "/",
      allowedDirs: [tmpDir],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_allowed");
      assert.equal(getProjectPathValidationErrorMessage(result.reason), "path is not allowed");
    }
  });

  it("returns not_exists for missing directories", () => {
    const target = path.join(tmpDir, "missing");
    const result = validateWorkspacePath({
      candidatePath: target,
      allowedDirs: [tmpDir],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_exists");
      assert.equal(result.absolutePath, path.resolve(target));
      assert.equal(getProjectPathValidationErrorMessage(result.reason), "path does not exist");
    }
  });

  it("returns not_directory for existing files", () => {
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "x");
    const result = validateWorkspacePath({
      candidatePath: filePath,
      allowedDirs: [tmpDir],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_directory");
      assert.equal(result.resolvedPath, path.resolve(filePath));
      assert.equal(getProjectPathValidationErrorMessage(result.reason), "path is not a directory");
    }
  });

  it("returns normalized paths for valid directories", () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const result = validateWorkspacePath({
      candidatePath: workspaceDir,
      allowedDirs: [tmpDir],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.absolutePath, path.resolve(workspaceDir));
      assert.equal(result.resolvedPath, path.resolve(workspaceDir));
      assert.equal(result.workspaceRoot, path.resolve(workspaceDir));
    }
  });

  it("normalizes nested directories back to git workspace root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const nestedDir = path.join(tmpDir, "packages", "worker");
    fs.mkdirSync(nestedDir, { recursive: true });

    const result = validateWorkspacePath({
      candidatePath: nestedDir,
      allowedDirs: [tmpDir],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolvedPath, path.resolve(nestedDir));
      assert.equal(result.workspaceRoot, path.resolve(tmpDir));
    }
    assert.equal(resolveWorkspaceRootFromDirectory(nestedDir), path.resolve(tmpDir));
  });

  it("falls back to the resolved directory when detected workspace root is outside the allow list", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const allowedRoot = path.join(tmpDir, "sandbox");
    const nestedDir = path.join(allowedRoot, "workspace");
    fs.mkdirSync(nestedDir, { recursive: true });

    const result = validateWorkspacePath({
      candidatePath: nestedDir,
      allowedDirs: [allowedRoot],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.workspaceRoot, path.resolve(nestedDir));
    }
  });

  it("can reject directories whose detected workspace root falls outside the allow list", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const allowedRoot = path.join(tmpDir, "sandbox");
    const nestedDir = path.join(allowedRoot, "workspace");
    fs.mkdirSync(nestedDir, { recursive: true });

    const result = validateWorkspacePath({
      candidatePath: nestedDir,
      allowedDirs: [allowedRoot],
      allowWorkspaceRootFallback: false,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_allowed");
      assert.equal(result.absolutePath, path.resolve(nestedDir));
      assert.equal(result.resolvedPath, path.resolve(nestedDir));
    }
  });
});
