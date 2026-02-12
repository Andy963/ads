import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { processSpecBlocks } from "../../src/utils/specRecording.js";

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-spec-"));
  return root;
}

describe("utils/specRecording", () => {
  it("records a spec block, writes spec files, and strips control blocks from output", async () => {
    const workspaceRoot = makeTempWorkspace();
    const text = [
      "Hello",
      "<<<spec",
      [
        'title: "My Spec"',
        'template_id: "unified"',
        "files:",
        "  requirements.md: |",
        "    # My Spec - Requirements",
        "    ",
        "    - Goal: do something",
        "  design.md: |",
        "    # My Spec - Design",
        "    - Approach: keep it simple",
        "  implementation.md: |",
        "    # My Spec - Implementation",
        "    - Steps: 1) do it",
      ].join("\n"),
      ">>>",
      "World",
    ].join("\n");

    const result = await processSpecBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 1);
    assert.equal(result.warnings.length, 0);
    assert.ok(!result.finalText.includes("<<<spec"));
    assert.ok(result.finalText.includes("Spec created: docs/spec/"));

    const specRef = result.results[0]!.specRef;
    const specDir = path.join(workspaceRoot, specRef);
    assert.ok(fs.existsSync(specDir));

    const requirements = fs.readFileSync(path.join(specDir, "requirements.md"), "utf8");
    const design = fs.readFileSync(path.join(specDir, "design.md"), "utf8");
    const implementation = fs.readFileSync(path.join(specDir, "implementation.md"), "utf8");

    assert.ok(requirements.includes("# My Spec - Requirements"));
    assert.ok(design.includes("# My Spec - Design"));
    assert.ok(implementation.includes("# My Spec - Implementation"));
  });

  it("ignores invalid YAML blocks with a warning (no crash)", async () => {
    const workspaceRoot = makeTempWorkspace();
    const text = ["Start", "<<<spec", "not: [valid", ">>>", "End"].join("\n");

    const result = await processSpecBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.finalText.includes("<<<spec"));
    assert.ok(result.finalText.includes("Spec warning:"));
  });

  it("refuses unsafe specRef outside docs/spec", async () => {
    const workspaceRoot = makeTempWorkspace();
    const text = [
      "<<<spec",
      [
        'title: "Unsafe Spec"',
        "specRef: \"../escape\"",
        "files:",
        "  requirements.md: |",
        "    # Unsafe",
        "  design.md: |",
        "    # Unsafe",
        "  implementation.md: |",
        "    # Unsafe",
      ].join("\n"),
      ">>>",
    ].join("\n");

    const result = await processSpecBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 0);
    assert.ok(result.warnings.some((w) => w.includes("invalid specRef")));
  });
});

