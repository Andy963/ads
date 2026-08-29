import { describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildWorkItemPromptPreamble,
  ISSUE_ROOT,
  normalizeIssueRef,
  normalizeSpecRef,
  resolveWorkItemPin,
  SPEC_ROOT,
  toWorkItemPinMetadata,
  validateWorkItemRefs,
} from "../../server/web/server/planner/workItem.js";
import { normalizeCreateTaskInput } from "../../server/web/server/planner/taskBundleApprover.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ads-work-item-pin-"));
}

function git(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function initRepoWithWorkItem(issueContent: string, requirementsContent: string): { root: string; requirementsPath: string } {
  const root = makeTempDir();
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  const issueDir = path.join(root, ISSUE_ROOT, "feature");
  const specDir = path.join(root, SPEC_ROOT, "feature");
  fs.mkdirSync(issueDir, { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(issueDir, "README.md"), issueContent, "utf8");
  const requirementsPath = path.join(specDir, "requirements.md");
  fs.writeFileSync(requirementsPath, requirementsContent, "utf8");
  fs.writeFileSync(path.join(specDir, "design.md"), "# Design\n", "utf8");
  return { root, requirementsPath };
}

describe("planner/workItem references", () => {
  it("accepts matching direct-child directories and rejects file references", () => {
    assert.equal(normalizeIssueRef("docs/issue/feature"), "docs/issue/feature");
    assert.equal(normalizeSpecRef("./docs/spec/feature/"), "docs/spec/feature");
    assert.equal(normalizeSpecRef("docs/spec/feature"), "docs/spec/feature");
    assert.equal(normalizeSpecRef("docs/spec/feature.md"), null);
    assert.equal(normalizeSpecRef("docs/spec/nested/feature"), null);
    assert.equal(normalizeIssueRef("docs/issue/feature_name"), null);
    assert.equal(normalizeSpecRef("docs/spec/feature/../other"), null);
    assert.equal(normalizeIssueRef("docs/issue/../../etc/passwd"), null);
  });

  it("requires the same key and the canonical entry files", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "docs/issue/feature"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs/spec/other"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/issue/feature/README.md"), "# Issue\n", "utf8");
    fs.writeFileSync(path.join(root, "docs/spec/other/requirements.md"), "# Requirements\n", "utf8");

    const mismatch = validateWorkItemRefs({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/other",
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.error, /same work-item key/);

    const missingEntry = validateWorkItemRefs({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/feature",
    });
    assert.equal(missingEntry.ok, false);
    if (!missingEntry.ok) assert.match(missingEntry.error, /specRef directory does not exist/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("planner/workItem pin", () => {
  it("pins every file in both directories", () => {
    const { root } = initRepoWithWorkItem("# Issue\n", "# Requirements\n\nApproved wording.\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "add work item"]);

    const pin = resolveWorkItemPin({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/feature",
    });
    assert.ok(pin);
    assert.equal(pin.status, "pinned");
    assert.equal(pin.workItemKey, "feature");
    assert.equal(pin.issue.files.length, 1);
    assert.equal(pin.spec.files.length, 2);
    assert.match(pin.spec.files[0]!.blobSha ?? "", /^[0-9a-f]{40}$/);
    assert.match(pin.spec.commitSha ?? "", /^[0-9a-f]{40}$/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps approved directory blobs readable after later edits", () => {
    const { root, requirementsPath } = initRepoWithWorkItem("# Issue\n", "# Requirements\n\nApproved wording.\n");
    const pin = resolveWorkItemPin({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/feature",
    });
    assert.equal(pin?.status, "pinned");
    const requirementsBlob = pin!.spec.files.find((file) => file.path.endsWith("requirements.md"))?.blobSha;
    assert.ok(requirementsBlob);

    fs.writeFileSync(requirementsPath, "# Requirements\n\nRewritten after approval.\n", "utf8");

    const shown = childProcess.spawnSync("git", ["show", requirementsBlob!], { cwd: root, encoding: "utf8" });
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /Approved wording/);
    assert.doesNotMatch(shown.stdout, /Rewritten after approval/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("pins uncommitted directories without changing git state", () => {
    const { root } = initRepoWithWorkItem("# Issue\n", "# Requirements\n\nNever committed.\n");
    const headBefore = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const statusBefore = childProcess.spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;

    const pin = resolveWorkItemPin({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/feature",
    });
    assert.equal(pin?.status, "pinned");
    assert.ok(pin?.issue.files.every((file) => file.blobSha));
    assert.ok(pin?.spec.files.every((file) => file.blobSha));

    const headAfter = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const statusAfter = childProcess.spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
    assert.equal(headAfter, headBefore);
    assert.equal(statusAfter, statusBefore);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("degrades to unpinned outside a git work tree", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "docs/issue/feature"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs/spec/feature"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/issue/feature/README.md"), "# Issue\n", "utf8");
    fs.writeFileSync(path.join(root, "docs/spec/feature/requirements.md"), "# Requirements\n", "utf8");

    const pin = resolveWorkItemPin({
      workspaceRoot: root,
      issueRef: "docs/issue/feature",
      specRef: "docs/spec/feature",
    });
    assert.equal(pin?.status, "unpinned");
    assert.match(pin?.reason ?? "", /not a git work tree/);
    assert.ok(pin?.issue.files.every((file) => file.blobSha === null));

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("planner/workItem prompt injection", () => {
  const pin = {
    workItemKey: "feature",
    status: "pinned" as const,
    issue: {
      path: "docs/issue/feature",
      status: "pinned" as const,
      files: [{ path: "docs/issue/feature/README.md", blobSha: "a".repeat(40) }],
      commitSha: "b".repeat(40),
      reason: null,
    },
    spec: {
      path: "docs/spec/feature",
      status: "pinned" as const,
      files: [{ path: "docs/spec/feature/requirements.md", blobSha: "c".repeat(40) }],
      commitSha: "b".repeat(40),
      reason: null,
    },
    reason: null,
  };

  it("prepends both pinned directories and preserves the original prompt", () => {
    const input = normalizeCreateTaskInput(
      "draft-1",
      { prompt: "Implement the acceptance criteria." },
      0,
      undefined,
      null,
      pin,
    );

    assert.match(input.prompt, /git show a{40}/);
    assert.match(input.prompt, /git show c{40}/);
    assert.match(input.prompt, /docs\/issue\/feature/);
    assert.match(input.prompt, /docs\/spec\/feature/);
    assert.ok(input.prompt.endsWith("Implement the acceptance criteria."));
    assert.deepEqual(input.modelParams, {
      specPin: {
        workItemKey: "feature",
        status: "pinned",
        issue: {
          path: "docs/issue/feature",
          status: "pinned",
          files: [{ path: "docs/issue/feature/README.md", blobSha: "a".repeat(40) }],
          commitSha: "b".repeat(40),
        },
        spec: {
          path: "docs/spec/feature",
          status: "pinned",
          files: [{ path: "docs/spec/feature/requirements.md", blobSha: "c".repeat(40) }],
          commitSha: "b".repeat(40),
        },
      },
    });
  });

  it("warns rather than silently dropping an unpinned work item", () => {
    const unpinned = {
      ...pin,
      status: "unpinned" as const,
      issue: { ...pin.issue, status: "unpinned" as const, files: [{ ...pin.issue.files[0]!, blobSha: null }] },
      spec: { ...pin.spec, status: "unpinned" as const, files: [{ ...pin.spec.files[0]!, blobSha: null }] },
      reason: "workspace is not a git work tree",
    };
    const preamble = buildWorkItemPromptPreamble(unpinned);
    assert.match(preamble, /could not be fully pinned/);
    assert.match(preamble, /docs\/issue\/feature/);
    assert.match(preamble, /docs\/spec\/feature/);
  });

  it("carries the directory snapshot and degrade reason into task metadata", () => {
    const unpinned = {
      ...pin,
      status: "unpinned" as const,
      reason: "workspace is not a git work tree",
    };
    const metadata = toWorkItemPinMetadata(unpinned);
    assert.equal(metadata.status, "unpinned");
    assert.equal(metadata.reason, "workspace is not a git work tree");
    assert.deepEqual(metadata.issue, {
      path: "docs/issue/feature",
      status: "pinned",
      files: [{ path: "docs/issue/feature/README.md", blobSha: "a".repeat(40) }],
      commitSha: "b".repeat(40),
    });
  });
});
