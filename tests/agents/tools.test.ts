import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { executeToolBlocks } from "../../src/agents/tools.js";

describe("agents/tools", { concurrency: 1 }, () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tmpDir: string | null = null;

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    originalEnv.ENABLE_AGENT_FILE_TOOLS = process.env.ENABLE_AGENT_FILE_TOOLS;
    originalEnv.ENABLE_AGENT_APPLY_PATCH = process.env.ENABLE_AGENT_APPLY_PATCH;
    originalEnv.PATH = process.env.PATH;

    setEnv("ENABLE_AGENT_FILE_TOOLS", "1");
    setEnv("ENABLE_AGENT_APPLY_PATCH", "1");

    const scratchRoot = path.join(process.cwd(), ".ads-test-tmp");
    fs.mkdirSync(scratchRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(scratchRoot, "agent-tools-"));
  });

  afterEach(() => {
    setEnv("ENABLE_AGENT_FILE_TOOLS", originalEnv.ENABLE_AGENT_FILE_TOOLS);
    setEnv("ENABLE_AGENT_APPLY_PATCH", originalEnv.ENABLE_AGENT_APPLY_PATCH);
    setEnv("PATH", originalEnv.PATH);

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("executes tool.write + tool.read", async () => {
    assert.ok(tmpDir);
    const context = { cwd: tmpDir, allowedDirs: [tmpDir] };

    const writeText = [
      "<<<tool.write",
      '{"path":"hello.txt","content":"hello\\n"}',
      ">>>",
    ].join("\n");
    const writeOutcome = await executeToolBlocks(writeText, undefined, context);
    assert.equal(writeOutcome.results.length, 1);
    assert.equal(writeOutcome.results[0]?.tool, "write");
    assert.equal(writeOutcome.results[0]?.ok, true);
    assert.equal(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf8"), "hello\n");

    const readText = [
      "<<<tool.read",
      '{"path":"hello.txt"}',
      ">>>",
    ].join("\n");
    const readOutcome = await executeToolBlocks(readText, undefined, context);
    assert.equal(readOutcome.results.length, 1);
    assert.equal(readOutcome.results[0]?.tool, "read");
    assert.equal(readOutcome.results[0]?.ok, true);
    assert.ok(readOutcome.replacedText.includes("hello"));
  });

  it("executes tool.apply_patch with unified diff", async () => {
    assert.ok(tmpDir);
    const context = { cwd: tmpDir, allowedDirs: [tmpDir] };

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "old\n", "utf8");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const patchText = ["<<<tool.apply_patch", patch, ">>>"].join("\n");
    const patchOutcome = await executeToolBlocks(patchText, undefined, context);
    assert.equal(patchOutcome.results.length, 1);
    assert.equal(patchOutcome.results[0]?.tool, "apply_patch");
    assert.equal(patchOutcome.results[0]?.ok, true);
    assert.equal(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8").trimEnd(), "new");
  });

  it("falls back to internal grep when rg is missing", async () => {
    assert.ok(tmpDir);
    const context = { cwd: tmpDir, allowedDirs: [tmpDir] };

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello [world]\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "b.md"), "hello [md]\n", "utf8");

    setEnv("PATH", "");

    const grepText = [
      "<<<tool.grep",
      JSON.stringify({ pattern: "[", glob: "*.txt" }),
      ">>>",
    ].join("\n");
    const grepOutcome = await executeToolBlocks(grepText, undefined, context);

    assert.equal(grepOutcome.results.length, 1);
    assert.equal(grepOutcome.results[0]?.tool, "grep");
    assert.equal(grepOutcome.results[0]?.ok, true);
    assert.match(grepOutcome.results[0]?.output ?? "", /a\.txt:1:hello \[world\]/);
    assert.ok(!grepOutcome.results[0]?.output.includes("b.md"));
  });

  it("falls back to internal find when fd/find are missing", async () => {
    assert.ok(tmpDir);
    const context = { cwd: tmpDir, allowedDirs: [tmpDir] };

    fs.mkdirSync(path.join(tmpDir, "dir"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dir", "x.ts"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "dir", "y.js"), "export const y = 1;\n", "utf8");

    setEnv("PATH", "");

    const findText = [
      "<<<tool.find",
      JSON.stringify({ pattern: "*.ts" }),
      ">>>",
    ].join("\n");
    const findOutcome = await executeToolBlocks(findText, undefined, context);

    assert.equal(findOutcome.results.length, 1);
    assert.equal(findOutcome.results[0]?.tool, "find");
    assert.equal(findOutcome.results[0]?.ok, true);
    assert.ok(findOutcome.results[0]?.output.includes("dir/x.ts"));
    assert.ok(!findOutcome.results[0]?.output.includes("dir/y.js"));
  });
});
