import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseAdsCli, runAdsFromCli } from "../../server/cli.js";

async function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await fn();
    return { exitCode, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("ads cli entrypoint", () => {
  test("defaults to starting the web server with no arguments", () => {
    assert.deepEqual(parseAdsCli([]), { type: "start" });
  });

  test("parses help flags", () => {
    assert.deepEqual(parseAdsCli(["--help"]), { type: "help" });
    assert.deepEqual(parseAdsCli(["-h"]), { type: "help" });
    assert.deepEqual(parseAdsCli(["help"]), { type: "help" });
  });

  test("parses version flags", () => {
    assert.deepEqual(parseAdsCli(["--version"]), { type: "version" });
    assert.deepEqual(parseAdsCli(["-v"]), { type: "version" });
    assert.deepEqual(parseAdsCli(["version"]), { type: "version" });
  });

  test("does not recognize retired subcommands", () => {
    for (const args of [["web"], ["web", "start"], ["telegram"]]) {
      const parsed = parseAdsCli(args);
      assert.equal(parsed.type, "error", args.join(" "));
      assert.equal(parsed.exitCode, 2);
      assert.match(parsed.message, /Unknown command/);
    }
  });

  test("unknown arguments return an error", () => {
    const parsed = parseAdsCli(["nope"]);
    assert.equal(parsed.type, "error");
    assert.equal(parsed.exitCode, 2);
    assert.match(parsed.message, /Unknown command/);
  });

  test("help output describes direct startup and exits 0", async () => {
    const { exitCode, output } = await captureStdout(() => runAdsFromCli(["--help"]));
    assert.equal(exitCode, 0);
    assert.match(output, /Usage:/);
    assert.match(output, /ads \[options\]/);
    assert.match(output, /--version/);
  });

  test("version reporting prints the package version and exits 0", async () => {
    const { exitCode, output } = await captureStdout(() => runAdsFromCli(["--version"]));
    assert.equal(exitCode, 0);
    assert.match(output, /^ADS v\d+\.\d+\.\d+/);
  });
});
