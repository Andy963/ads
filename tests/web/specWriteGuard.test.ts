import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  enforceWriteAllowlist,
  formatWriteGuardMessage,
  isWithinWriteRoots,
  resolvePlannerWriteRoots,
  snapshotDirtyFiles,
} from "../../server/web/server/planner/specWriteGuard.js";

function git(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function read(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("planner/specWriteGuard", () => {
  let root: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-write-guard-"));
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    write(root, "src/app.ts", "export const value = 1;\n");
    write(root, "docs/spec/.keep", "");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "init"]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("leaves spec writes alone", () => {
    const before = snapshotDirtyFiles(root);
    write(root, "docs/spec/feature.md", "# Feature\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 1 });

    assert.deepEqual(outcome.reverted, []);
    assert.deepEqual(outcome.flagged, []);
    assert.equal(read(root, "docs/spec/feature.md"), "# Feature\n");
  });

  it("reverts a new file written outside the allowlist", () => {
    const before = snapshotDirtyFiles(root);
    write(root, "src/sneaky.ts", "export const hacked = true;\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 2 });

    assert.deepEqual(outcome.reverted, ["src/sneaky.ts"]);
    assert.equal(fs.existsSync(path.join(root, "src/sneaky.ts")), false);
  });

  it("reverts a tracked file modified outside the allowlist", () => {
    const before = snapshotDirtyFiles(root);
    write(root, "src/app.ts", "export const value = 999;\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 3 });

    assert.deepEqual(outcome.reverted, ["src/app.ts"]);
    assert.equal(read(root, "src/app.ts"), "export const value = 1;\n");
  });

  it("keeps a recoverable copy of everything it reverts", () => {
    const before = snapshotDirtyFiles(root);
    write(root, "src/sneaky.ts", "export const hacked = true;\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 4 });

    assert.ok(outcome.quarantineDir);
    assert.equal(fs.readFileSync(path.join(outcome.quarantineDir!, "src/sneaky.ts"), "utf8"), "export const hacked = true;\n");
  });

  it("never reverts work the user already had in progress", () => {
    // The user is mid-edit when the planner turn starts. Rolling this back would
    // destroy uncommitted work — strictly worse than leaving it flagged.
    write(root, "src/app.ts", "export const value = 42; // user's WIP\n");
    write(root, "src/untracked-note.md", "user scratch\n");
    const before = snapshotDirtyFiles(root);

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 5 });

    assert.deepEqual(outcome.reverted, []);
    assert.deepEqual(outcome.flagged, []);
    assert.equal(read(root, "src/app.ts"), "export const value = 42; // user's WIP\n");
    assert.equal(read(root, "src/untracked-note.md"), "user scratch\n");
  });

  it("flags but does not revert a user-dirty file the planner then modified", () => {
    write(root, "src/app.ts", "export const value = 42; // user's WIP\n");
    const before = snapshotDirtyFiles(root);
    write(root, "src/app.ts", "export const value = 43; // planner overwrote\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 6 });

    assert.deepEqual(outcome.reverted, []);
    assert.deepEqual(outcome.flagged, ["src/app.ts"]);
    // Left on disk: the user's version is already gone, and `git checkout` would
    // discard their WIP rather than restore it.
    assert.match(read(root, "src/app.ts"), /planner overwrote/);
  });

  it("handles paths containing spaces", () => {
    const before = snapshotDirtyFiles(root);
    write(root, "src/a file with spaces.ts", "export const x = 1;\n");

    const outcome = enforceWriteAllowlist({ workspaceRoot: root, before, roots: ["docs/spec"], timestamp: 7 });

    assert.deepEqual(outcome.reverted, ["src/a file with spaces.ts"]);
    assert.equal(fs.existsSync(path.join(root, "src/a file with spaces.ts")), false);
  });

  it("reports unavailable outside a git work tree instead of silently passing", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ads-write-guard-plain-"));
    assert.equal(snapshotDirtyFiles(plain), null);

    const outcome = enforceWriteAllowlist({ workspaceRoot: plain, before: null, roots: ["docs/spec"], timestamp: 8 });
    assert.match(outcome.unavailableReason ?? "", /not a git work tree/);

    fs.rmSync(plain, { recursive: true, force: true });
  });

  it("resolves write roots from env, defaulting to the paired work-item roots", () => {
    delete process.env.ADS_PLANNER_WRITE_ROOTS;
    assert.deepEqual(resolvePlannerWriteRoots(), ["docs/issue", "docs/spec"]);

    process.env.ADS_PLANNER_WRITE_ROOTS = "docs/spec, notes/ ,./plans";
    assert.deepEqual(resolvePlannerWriteRoots(), ["docs/spec", "notes", "plans"]);
  });

  it("does not treat a sibling prefix as inside the allowlist", () => {
    assert.equal(isWithinWriteRoots("docs/spec/a.md", ["docs/spec"]), true);
    assert.equal(isWithinWriteRoots("docs/spec", ["docs/spec"]), true);
    assert.equal(isWithinWriteRoots("docs/specification/a.md", ["docs/spec"]), false);
    assert.equal(isWithinWriteRoots("docs/spec-old/a.md", ["docs/spec"]), false);
  });

  it("stays silent when nothing crossed the line", () => {
    const outcome = { reverted: [], flagged: [], quarantineDir: null, unavailableReason: null };
    assert.equal(formatWriteGuardMessage(outcome, ["docs/spec"]), null);
  });
});
