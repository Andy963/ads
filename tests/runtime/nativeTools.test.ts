import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeToolExecutor } from "../../server/runtime/tools.js";
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
      timeout_ms: 120_000,
    }));
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  });

  it("dispatches an action job to the queue via native executor", async () => {
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const res = await executor.execute(call("dispatch_action_job", {
      issue_id: 123,
      title: "Native task",
    }));
    const parsed = JSON.parse(res.output) as { ok: boolean; job_id: string; status: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, "queued");
    assert.ok(parsed.job_id.startsWith("job-"));
  });
});
