import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseAdsCli } from "../../server/cli.js";

describe("ads unified cli entrypoint", () => {
  test("defaults to help for ads", () => {
    assert.deepEqual(parseAdsCli([], "ads"), { type: "help", scope: "root" });
  });

  test("parses top-level help/version flags", () => {
    assert.deepEqual(parseAdsCli(["--help"], "ads"), { type: "help", scope: "root" });
    assert.deepEqual(parseAdsCli(["-v"], "ads"), { type: "version" });
  });

  test("parses web subcommand", () => {
    assert.deepEqual(parseAdsCli(["web"], "ads"), { type: "start", service: "web" });
  });

  test("does not recognize removed telegram commands", () => {
    const parsedTg = parseAdsCli(["telegram"], "ads");
    assert.deepEqual(parsedTg, {
      type: "error",
      exitCode: 2,
      message: "❌ Unknown command: telegram",
    });

    const parsedAlias = parseAdsCli([], "ads-telegram");
    assert.deepEqual(parsedAlias, { type: "help", scope: "root" });
  });

  test("unknown subcommand returns an error", () => {
    const parsed = parseAdsCli(["nope"], "ads");
    assert.equal(parsed.type, "error");
    assert.equal(parsed.exitCode, 2);
    assert.match(parsed.message, /Unknown command/);
  });
});
