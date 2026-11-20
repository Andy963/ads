import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NATIVE_TOOL_DEFINITIONS, NativeToolExecutor } from "../../server/runtime/tools.js";
import type { NativeChatToolCall } from "../../server/runtime/openAiCompatibleClient.js";

function call(name: string, args: Record<string, unknown>): NativeChatToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("NativeToolExecutor", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-tools-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("reads bounded files with one-based line numbers", async () => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });

    const result = await executor.execute(call("read_file", { file: "notes.txt", start_line: 2, line_count: 1 }));

    assert.match(result.output, /"content":"2: beta"/);
  });

  it("reads up to 1,000 lines by default", async () => {
    const lines = Array.from({ length: 1_001 }, (_, index) => `line-${index + 1}`);
    fs.writeFileSync(path.join(workspace, "long.txt"), `${lines.join("\n")}\n`, "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });

    const result = await executor.execute(call("read_file", { file: "long.txt" }));
    const payload = JSON.parse(result.output) as { line_count: number; content: string };

    assert.equal(payload.line_count, 1_000);
    assert.match(payload.content, /1000: line-1000/);
    assert.doesNotMatch(payload.content, /1001: line-1001/);
  });

  it("separates command waiting from optional execution deadlines", async () => {
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const pending = executor.execute(call("exec_command", {
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      timeout_ms: 600_000,
    }));
    const result = await pending;

    assert.equal(JSON.parse(result.output).timed_out, false);
    const definition = NATIVE_TOOL_DEFINITIONS.find(item => item.function.name === "exec_command");
    assert.equal(definition?.function.parameters.properties?.timeout_ms, undefined);
    const deadlineSchema = definition?.function.parameters.properties?.max_runtime_ms as { maximum?: number } | undefined;
    assert.ok(deadlineSchema?.maximum && deadlineSchema.maximum > 600_000);
  });

  it("rejects symlink escapes and blocked commands", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret.txt"));
      const executor = new NativeToolExecutor({ workspaceRoot: workspace });

      await assert.rejects(
        executor.execute(call("read_file", { file: "secret.txt" })),
        /symlink target escapes/i,
      );
      await assert.rejects(
        executor.execute(call("exec_command", { cmd: "rm", args: ["-f", "state.db"] })),
        /blocked by security rule/i,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("applies a context patch atomically", async () => {
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "file.txt"), "before\nkeep\n", "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/file.txt",
      "@@",
      " before",
      "-keep",
      "+after",
      "*** End Patch",
    ].join("\n");

    const result = await executor.execute(call("apply_patch", { patch }));

    assert.match(result.output, /applied/);
    assert.equal(fs.readFileSync(path.join(workspace, "src", "file.txt"), "utf8"), "before\nafter\n");
  });

  it("preserves trailing whitespace on matched patch context lines", async () => {
    fs.writeFileSync(path.join(workspace, "whitespace.txt"), "before  \nkeep\n", "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const patch = [
      "*** Begin Patch",
      "*** Update File: whitespace.txt",
      "@@",
      " before",
      "-keep",
      "+after",
      "*** End Patch",
    ].join("\n");

    await executor.execute(call("apply_patch", { patch }));

    assert.equal(fs.readFileSync(path.join(workspace, "whitespace.txt"), "utf8"), "before  \nafter\n");
  });

  it("does not write any file when a later patch hunk fails", async () => {
    fs.writeFileSync(path.join(workspace, "one.txt"), "one\n", "utf8");
    fs.writeFileSync(path.join(workspace, "two.txt"), "two\n", "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const patch = [
      "*** Begin Patch",
      "*** Update File: one.txt",
      "@@",
      "-one",
      "+changed",
      "*** Update File: two.txt",
      "@@",
      "-missing",
      "+changed",
      "*** End Patch",
    ].join("\n");

    await assert.rejects(executor.execute(call("apply_patch", { patch })), /context did not match/i);
    assert.equal(fs.readFileSync(path.join(workspace, "one.txt"), "utf8"), "one\n");
    assert.equal(fs.readFileSync(path.join(workspace, "two.txt"), "utf8"), "two\n");
  });

  it("inherits the provided environment including secret-shaped variables", async () => {
    const executor = new NativeToolExecutor({
      workspaceRoot: workspace,
      env: { PATH: process.env.PATH, NATIVE_TEST_TOKEN: "should-be-visible" },
    });

    const result = await executor.execute(call("exec_command", {
      cmd: process.execPath,
      args: ["-e", "process.stdout.write(String(process.env.NATIVE_TEST_TOKEN || 'missing'))"],
    }));

    assert.match(result.output, /should-be-visible/);
  });

  it("uses context-aware redaction for short secrets", async () => {
    const executor = new NativeToolExecutor({
      workspaceRoot: workspace,
      redactions: ["q", "/"],
    });
    const result = await executor.execute(call("exec_command", {
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('q /tmp/q\\nsecret=q\\n/')"],
    }));

    assert.match(result.output, /q \/tmp\/q/);
    assert.match(result.output, /secret=\[redacted\]/);
    assert.match(result.output, /stdout[^\n]*\[redacted\]/);
  });

  it("tokenizes a complete command string without invoking a shell", async () => {
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const result = await executor.execute(call("exec_command", {
      cmd: `${process.execPath} -e "process.stdout.write(process.argv.slice(1).join('|'))" "first value" second`,
    }));

    assert.match(result.output, /first value\|second/);
  });

  it("runs pipelines and compound commands directly on the host", async () => {
    fs.mkdirSync(path.join(workspace, "nested"));
    fs.writeFileSync(path.join(workspace, "nested", "value.txt"), "hello\n", "utf8");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });

    const pipeline = await executor.execute(call("exec_command", {
      cmd: "printf 'hello\\nworld\\n' | head -n 1",
    }));
    const compound = await executor.execute(call("exec_command", {
      cmd: "cd nested && cat value.txt",
    }));
    const nodePipeline = await executor.execute(call("exec_command", {
      cmd: `${process.execPath} -e "process.stdout.write('node\\n')" | head -n 1`,
    }));

    const pipelineOutput = JSON.parse(pipeline.output) as { stdout?: string };
    const compoundOutput = JSON.parse(compound.output) as { stdout?: string };
    const nodePipelineOutput = JSON.parse(nodePipeline.output) as { stdout?: string };
    assert.equal(pipelineOutput.stdout, "hello");
    assert.equal(compoundOutput.stdout, "hello");
    assert.equal(nodePipelineOutput.stdout, "node");
  });

  it("enforces executable allowlists for each shell pipeline segment", async () => {
    const executor = new NativeToolExecutor({
      workspaceRoot: workspace,
      env: { PATH: process.env.PATH, AGENT_EXEC_TOOL_ALLOWLIST: "printf" },
    });

    await assert.rejects(
      executor.execute(call("exec_command", { cmd: "printf hello | cat" })),
      /command not allowed: cat/i,
    );
  });

  it("propagates aborts to a running command", async () => {
    const controller = new AbortController();
    const executor = new NativeToolExecutor({ workspaceRoot: workspace, signal: controller.signal });
    const pending = executor.execute(call("exec_command", {
      cmd: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeout_ms: 600_000,
    }));
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  });

  it("rejects synchronous tools after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new NativeToolExecutor({ workspaceRoot: workspace, signal: controller.signal });
    const patch = [
      "*** Begin Patch",
      "*** Add File: should-not-exist.txt",
      "+created after cancellation",
      "*** End Patch",
    ].join("\n");

    await assert.rejects(
      executor.execute(call("apply_patch", { patch })),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(fs.existsSync(path.join(workspace, "should-not-exist.txt")), false);
  });
});
