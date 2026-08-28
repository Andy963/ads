import { describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SPEC_ROOT,
  buildSpecPromptPreamble,
  normalizeSpecRef,
  resolveSpecPin,
  toSpecPinMetadata,
} from "../../server/web/server/planner/specPin.js";
import { normalizeCreateTaskInput } from "../../server/web/server/planner/taskBundleApprover.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ads-specpin-"));
}

function git(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function initRepoWithSpec(content: string): { root: string; specPath: string } {
  const root = makeTempDir();
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  const specPath = path.join(root, SPEC_ROOT, "feature.md");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, content, "utf8");
  return { root, specPath };
}

describe("planner/specPin normalizeSpecRef", () => {
  it("accepts paths under the spec root", () => {
    assert.equal(normalizeSpecRef("docs/spec/feature.md"), "docs/spec/feature.md");
    assert.equal(normalizeSpecRef("./docs/spec/nested/feature.md"), "docs/spec/nested/feature.md");
  });

  it("rejects traversal, absolute paths and anything outside the spec root", () => {
    assert.equal(normalizeSpecRef("docs/spec/../../etc/passwd"), null);
    assert.equal(normalizeSpecRef("../docs/spec/feature.md"), null);
    assert.equal(normalizeSpecRef("/etc/passwd"), null);
    assert.equal(normalizeSpecRef("docs/other/feature.md"), null);
    assert.equal(normalizeSpecRef("server/config.ts"), null);
    assert.equal(normalizeSpecRef(""), null);
    assert.equal(normalizeSpecRef(undefined), null);
  });

  it("rejects the bare spec root because it is a directory", () => {
    assert.equal(normalizeSpecRef("docs/spec"), null);
  });
});

describe("planner/specPin resolveSpecPin", () => {
  it("pins a committed spec to its blob sha", () => {
    const { root } = initRepoWithSpec("# Feature\n\nStage 1.\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "add spec"]);

    const pin = resolveSpecPin({ workspaceRoot: root, specRef: "docs/spec/feature.md" });
    assert.ok(pin);
    assert.equal(pin.status, "pinned");
    assert.match(pin.blobSha ?? "", /^[0-9a-f]{40}$/);
    assert.match(pin.commitSha ?? "", /^[0-9a-f]{40}$/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the approved blob readable after the spec changes on disk", () => {
    const { root, specPath } = initRepoWithSpec("# Feature\n\nApproved wording.\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "add spec"]);

    const pin = resolveSpecPin({ workspaceRoot: root, specRef: "docs/spec/feature.md" });
    assert.equal(pin?.status, "pinned");

    fs.writeFileSync(specPath, "# Feature\n\nRewritten after approval.\n", "utf8");

    const shown = childProcess.spawnSync("git", ["show", pin!.blobSha!], { cwd: root, encoding: "utf8" });
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /Approved wording/);
    assert.doesNotMatch(shown.stdout, /Rewritten after approval/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("degrades to unpinned when the spec is not committed", () => {
    const { root } = initRepoWithSpec("# Feature\n");
    const pin = resolveSpecPin({ workspaceRoot: root, specRef: "docs/spec/feature.md" });
    assert.equal(pin?.status, "unpinned");
    assert.equal(pin?.blobSha, null);
    assert.match(pin?.reason ?? "", /not committed/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("degrades to unpinned outside a git work tree", () => {
    const root = makeTempDir();
    const pin = resolveSpecPin({ workspaceRoot: root, specRef: "docs/spec/feature.md" });
    assert.equal(pin?.status, "unpinned");
    assert.match(pin?.reason ?? "", /not a git work tree/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks an out-of-root reference invalid instead of resolving it", () => {
    const { root } = initRepoWithSpec("# Feature\n");
    const pin = resolveSpecPin({ workspaceRoot: root, specRef: "../../etc/passwd" });
    assert.equal(pin?.status, "invalid");
    assert.equal(pin?.blobSha, null);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no spec is referenced at all", () => {
    assert.equal(resolveSpecPin({ workspaceRoot: "/tmp", specRef: undefined }), null);
    assert.equal(resolveSpecPin({ workspaceRoot: "/tmp", specRef: "   " }), null);
  });
});

describe("planner/specPin prompt injection", () => {
  it("prepends the pinned spec block and preserves the original prompt", () => {
    const pin = {
      path: "docs/spec/feature.md",
      status: "pinned" as const,
      blobSha: "a".repeat(40),
      commitSha: "b".repeat(40),
      reason: null,
    };

    const input = normalizeCreateTaskInput("draft-1", { prompt: "Implement stage 2." }, 0, undefined, null, pin);

    assert.match(input.prompt, /git show a{40}/);
    assert.match(input.prompt, /docs\/spec\/feature\.md/);
    assert.ok(input.prompt.endsWith("Implement stage 2."));
    assert.deepEqual(input.modelParams, {
      specPin: { path: "docs/spec/feature.md", status: "pinned", blobSha: "a".repeat(40), commitSha: "b".repeat(40) },
    });
  });

  it("leaves the prompt untouched when there is no spec", () => {
    const input = normalizeCreateTaskInput("draft-1", { prompt: "Implement stage 2." }, 0);
    assert.equal(input.prompt, "Implement stage 2.");
    assert.equal(input.modelParams, undefined);
  });

  it("warns rather than silently dropping an unpinned spec", () => {
    const preamble = buildSpecPromptPreamble({
      path: "docs/spec/feature.md",
      status: "unpinned",
      blobSha: null,
      commitSha: null,
      reason: "spec file is not committed at HEAD",
    });
    assert.match(preamble, /could not be pinned/);
    assert.match(preamble, /docs\/spec\/feature\.md/);
  });

  it("carries the degrade reason into task metadata", () => {
    const metadata = toSpecPinMetadata({
      path: "docs/spec/feature.md",
      status: "unpinned",
      blobSha: null,
      commitSha: null,
      reason: "spec file is not committed at HEAD",
    });
    assert.equal(metadata.status, "unpinned");
    assert.equal(metadata.reason, "spec file is not committed at HEAD");
  });
});
