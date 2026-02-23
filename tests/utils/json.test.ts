import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

const { parseJsonWithSchema, safeParseJson, safeParseJsonFromUnknown, safeParseJsonWithSchema } = await import(
  "../../src/utils/json.js"
);

describe("utils/json", () => {
  it("safeParseJson returns parsed value for valid JSON", () => {
    const parsed = safeParseJson<{ a: number }>('{"a":1}');
    assert.deepEqual(parsed, { a: 1 });
  });

  it("safeParseJson returns null for empty/invalid input", () => {
    assert.equal(safeParseJson(""), null);
    assert.equal(safeParseJson("   "), null);
    assert.equal(safeParseJson("not-json"), null);
  });

  it("safeParseJsonFromUnknown returns null for non-strings", () => {
    assert.equal(safeParseJsonFromUnknown(1), null);
    assert.equal(safeParseJsonFromUnknown(null), null);
    assert.equal(safeParseJsonFromUnknown(undefined), null);
    assert.equal(safeParseJsonFromUnknown({}), null);
  });

  it("safeParseJsonFromUnknown trims and parses strings", () => {
    const parsed = safeParseJsonFromUnknown<{ a: number }>('  {"a":1}  ');
    assert.deepEqual(parsed, { a: 1 });
  });

  it("safeParseJsonWithSchema validates payload", () => {
    const schema = z.object({ a: z.number() });
    assert.deepEqual(safeParseJsonWithSchema('{"a":1}', schema), { a: 1 });
    assert.equal(safeParseJsonWithSchema('{"a":"1"}', schema), null);
    assert.equal(safeParseJsonWithSchema("not-json", schema), null);
  });

  it("parseJsonWithSchema throws on invalid payloads", () => {
    const schema = z.object({ a: z.number() });
    assert.throws(() => parseJsonWithSchema("not-json", schema), /Invalid JSON payload/);
    assert.throws(() => parseJsonWithSchema('{"a":"1"}', schema), /Invalid JSON payload/);
  });
});

