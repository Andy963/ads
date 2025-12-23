import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { processAdrBlocks } from "../../src/utils/adrRecording.js";

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-adr-"));
  return root;
}

describe("utils/adrRecording", () => {
  const originalEnv = process.env.ADS_ADR_ENABLED;

  beforeEach(() => {
    delete process.env.ADS_ADR_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADS_ADR_ENABLED;
    } else {
      process.env.ADS_ADR_ENABLED = originalEnv;
    }
  });

  it("records multiple ADR blocks and strips control blocks from output", () => {
    const workspaceRoot = makeTempWorkspace();
    const text = [
      "Hello",
      "<<<adr",
      JSON.stringify({ title: "Decision 1", decision: "Use X" }),
      ">>>",
      "World",
      "<<<adr",
      JSON.stringify({ body: "# My ADR\nSome details\n" }),
      ">>>",
      "Done",
    ].join("\n");

    const result = processAdrBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 2);
    assert.equal(result.warnings.length, 0);
    assert.ok(!result.finalText.includes("<<<adr"));
    assert.ok(result.finalText.includes("ADR recorded: docs/adr/0001-"));
    assert.ok(result.finalText.includes("ADR recorded: docs/adr/0002-"));

    for (const entry of result.results) {
      assert.ok(fs.existsSync(entry.absolutePath));
    }

    const readmePath = path.join(workspaceRoot, "docs", "adr", "README.md");
    assert.ok(fs.existsSync(readmePath));
    const readme = fs.readFileSync(readmePath, "utf8");
    assert.ok(readme.includes("<!-- ADS:ADR_INDEX_START -->"));
    assert.ok(readme.includes("<!-- ADS:ADR_INDEX_END -->"));
    assert.ok(readme.includes("- 0001 - "));
    assert.ok(readme.includes("- 0002 - "));
  });

  it("ignores invalid JSON blocks with a warning (no crash)", () => {
    const workspaceRoot = makeTempWorkspace();
    const text = ["Start", "<<<adr", "{not json", ">>>", "End"].join("\n");

    const result = processAdrBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.finalText.includes("<<<adr"));
    assert.ok(result.finalText.includes("ADR warning:"));
    assert.ok(!fs.existsSync(path.join(workspaceRoot, "docs", "adr")));
  });

  it("does nothing when ADS_ADR_ENABLED=0 (no parse, no strip, no write)", () => {
    process.env.ADS_ADR_ENABLED = "0";
    const workspaceRoot = makeTempWorkspace();
    const text = ["Start", "<<<adr", JSON.stringify({ title: "Nope" }), ">>>", "End"].join("\n");

    const result = processAdrBlocks(text, workspaceRoot);

    assert.equal(result.finalText, text);
    assert.equal(result.cleanedText, text);
    assert.equal(result.results.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.ok(!fs.existsSync(path.join(workspaceRoot, "docs", "adr")));
  });

  it("chooses the next available number and never overwrites", () => {
    const workspaceRoot = makeTempWorkspace();
    const adrDir = path.join(workspaceRoot, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.writeFileSync(path.join(adrDir, "0002-existing.md"), "# 0002. Existing\n", "utf8");

    const text = ["<<<adr", JSON.stringify({ title: "New Decision" }), ">>>"].join("\n");
    const result = processAdrBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].relativePath.startsWith("docs/adr/0003-"));
    assert.ok(fs.existsSync(result.results[0].absolutePath));
  });

  it("updates README index idempotently (single marker block)", () => {
    const workspaceRoot = makeTempWorkspace();
    const text = ["<<<adr", JSON.stringify({ title: "First" }), ">>>"].join("\n");

    processAdrBlocks(text, workspaceRoot);
    processAdrBlocks(text, workspaceRoot);

    const readmePath = path.join(workspaceRoot, "docs", "adr", "README.md");
    const readme = fs.readFileSync(readmePath, "utf8");
    assert.equal(readme.split("<!-- ADS:ADR_INDEX_START -->").length - 1, 1);
    assert.equal(readme.split("<!-- ADS:ADR_INDEX_END -->").length - 1, 1);
  });

  it("does not throw on filesystem errors and returns a warning", () => {
    const workspaceRoot = makeTempWorkspace();
    // Make docs a file so creating docs/adr will fail deterministically.
    fs.writeFileSync(path.join(workspaceRoot, "docs"), "not a directory", "utf8");

    const text = ["Start", "<<<adr", JSON.stringify({ title: "Should fail" }), ">>>", "End"].join("\n");
    const result = processAdrBlocks(text, workspaceRoot);

    assert.equal(result.results.length, 0);
    assert.ok(!result.finalText.includes("<<<adr"));
    assert.ok(result.finalText.includes("ADR warning:"));
  });
});
