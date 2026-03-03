import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseCsv } = await import("../../server/utils/text.js");

describe("utils/text", () => {
  it("parseCsv splits and trims entries", () => {
    assert.deepEqual(parseCsv(undefined), []);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("   "), []);
    assert.deepEqual(parseCsv("a,b,c"), ["a", "b", "c"]);
    assert.deepEqual(parseCsv(" a , b , , c "), ["a", "b", "c"]);
  });
});

