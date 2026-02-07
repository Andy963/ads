import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runCli, runCliRaw } from "../../src/agents/cli/cliRunner.js";

describe("cliRunner", () => {
  it("parses JSONL output and skips noise", async () => {
    const lines: unknown[] = [];
    const node = process.execPath;
    const script = [
      "console.log('{\"type\":\"a\"}')",
      "console.log('noise')",
      "console.log('{\"type\":\"b\",\"value\":1}')",
    ].join(";");

    const result = await runCli({ binary: node, args: ["-e", script] }, (parsed) => lines.push(parsed));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(lines, [{ type: "a" }, { type: "b", value: 1 }]);
  });

  it("captures raw stdout for non-JSON commands", async () => {
    const node = process.execPath;
    const script = "process.stdout.write('hello\\nworld\\n'); process.stderr.write('err')";
    const result = await runCliRaw({ binary: node, args: ["-e", script] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello\nworld");
    assert.equal(result.stderr, "err");
  });
});

