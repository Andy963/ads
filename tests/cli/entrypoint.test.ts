import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseAdsCli } from "../../server/cli.js";

describe("ads unified cli entrypoint", () => {
  test("defaults to help for ads", () => {
    assert.deepEqual(parseAdsCli([], "ads"), { type: "help", scope: "root" });
  });

  test("defaults to telegram start for ads-telegram", () => {
    assert.deepEqual(parseAdsCli([], "ads-telegram"), { type: "start", service: "telegram" });
  });

  test("parses top-level help/version flags", () => {
    assert.deepEqual(parseAdsCli(["--help"], "ads"), { type: "help", scope: "root" });
    assert.deepEqual(parseAdsCli(["-v"], "ads"), { type: "version" });
  });

  test("parses web/telegram subcommands", () => {
    assert.deepEqual(parseAdsCli(["web"], "ads"), { type: "start", service: "web" });
    assert.deepEqual(parseAdsCli(["telegram"], "ads"), { type: "start", service: "telegram" });
    assert.deepEqual(parseAdsCli(["telegram", "help"], "ads"), { type: "help", scope: "telegram" });
  });

  test("unknown subcommand returns an error", () => {
    const parsed = parseAdsCli(["nope"], "ads");
    assert.equal(parsed.type, "error");
    assert.equal(parsed.exitCode, 2);
    assert.match(parsed.message, /Unknown command/);
  });
});

