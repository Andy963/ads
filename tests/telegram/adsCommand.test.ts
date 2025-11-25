import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseInlineAdsCommand, parsePlainAdsCommand } from "../../src/telegram/utils/adsCommand.js";

describe("parseInlineAdsCommand", () => {
  test("parses simple /ads.<command> inputs", () => {
    assert.deepEqual(parseInlineAdsCommand("/ads.status"), ["status"]);
    assert.deepEqual(parseInlineAdsCommand("/ads.log 5 req_demo"), ["log", "5", "req_demo"]);
  });

  test("handles hyphenated commands and bot mentions", () => {
    assert.deepEqual(parseInlineAdsCommand("/ads.status@MyBot extra args"), ["status", "extra", "args"]);
  });

  test("ignores non-inline ADS commands", () => {
    assert.equal(parseInlineAdsCommand("/ads status"), null);
    assert.equal(parseInlineAdsCommand("/something-else"), null);
    assert.equal(parseInlineAdsCommand("random text"), null);
  });

  test("is case-insensitive and skips incomplete commands", () => {
    assert.deepEqual(parseInlineAdsCommand("/ADS.BRANCH --delete foo"), ["branch", "--delete", "foo"]);
    assert.equal(parseInlineAdsCommand("/ads."), null);
  });
});

describe("parsePlainAdsCommand", () => {
  test("parses simple text commands with ads.<command> prefix", () => {
    assert.deepEqual(parsePlainAdsCommand("ads.status"), ["status"]);
    assert.deepEqual(parsePlainAdsCommand("ADS.COMMIT requirement"), ["commit", "requirement"]);
  });

  test("ignores incomplete or non-matching text", () => {
    assert.equal(parsePlainAdsCommand("ads"), null);
    assert.equal(parsePlainAdsCommand("ads."), null);
    assert.equal(parsePlainAdsCommand("ads status"), null);
    assert.equal(parsePlainAdsCommand("adsorption process"), null);
    assert.equal(parsePlainAdsCommand("/ads.status"), null);
    assert.equal(parsePlainAdsCommand("random text"), null);
  });

  test("preserves additional arguments", () => {
    assert.deepEqual(parsePlainAdsCommand("ads.log 10 req_demo"), ["log", "10", "req_demo"]);
  });
});
