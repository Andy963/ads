import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { assertCommandAllowed, runCommand } from "../../src/utils/commandRunner.js";

describe("utils/commandRunner", () => {
  it("rejects command paths when allowlist is enabled", async () => {
    const cmd = path.join("tmp", "git");

    await assert.rejects(
      () =>
        runCommand({
          cmd,
          args: ["status"],
          cwd: process.cwd(),
          timeoutMs: 1000,
          allowlist: ["git"],
        }),
      /command path is not allowed/i,
    );
  });

  it("allows bare command names when allowlist is enabled", async () => {
    const res = await runCommand({
      cmd: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      allowlist: ["node"],
    });

    assert.equal(res.exitCode, 0);
  });

  it("allows absolute paths when allowlist is disabled", async () => {
    const res = await runCommand({
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      allowlist: null,
    });

    assert.equal(res.exitCode, 0);
  });

  it("blocks git push even when command is allowlisted", () => {
    assert.throws(() => {
      assertCommandAllowed("git", ["push"], ["git"]);
    }, /git push is blocked/i);
  });

  it("rejects with AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);

    try {
      await assert.rejects(
        runCommand({
          cmd: "node",
          args: ["-e", "setTimeout(() => {}, 10_000)"],
          cwd: process.cwd(),
          timeoutMs: 10_000,
          signal: controller.signal,
        }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("marks timedOut when the command exceeds timeoutMs", async () => {
    const res = await runCommand({
      cmd: "node",
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    assert.equal(res.timedOut, true);
  });

  it("truncates stdout when maxOutputBytes is exceeded", async () => {
    const res = await runCommand({
      cmd: "node",
      args: ["-e", "process.stdout.write('a'.repeat(100))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 10,
    });

    assert.equal(res.truncatedStdout, true);
    assert.equal(res.stdout.length, 10);
  });
});
