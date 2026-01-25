import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { runCommand } from "../../src/utils/commandRunner.js";

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
});
