import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { deriveLegacyWebUserId, deriveWebUserId } from "../../src/web/utils.js";

describe("web/utils deriveWebUserId", () => {
  it("derives a stable 48-bit userId with a dedicated prefix", () => {
    const token = "t";
    const session = "s";

    const base = `${token}::${session}`;
    const hash = crypto.createHash("sha256").update(base).digest();
    const expected = 0x700000000000 + hash.readUIntBE(0, 6);

    const first = deriveWebUserId(token, session);
    const second = deriveWebUserId(token, session);

    assert.equal(first, expected);
    assert.equal(second, expected);
    assert.ok(Number.isSafeInteger(first));
    assert.ok(first >= 0x700000000000);
  });

  it("keeps legacy 32-bit derivation available for migration", () => {
    const token = "t";
    const session = "s";
    const base = `${token}::${session}`;
    const hash = crypto.createHash("sha256").update(base).digest();
    const expected = 0x70000000 + hash.readUInt32BE(0);

    const legacy = deriveLegacyWebUserId(token, session);
    assert.equal(legacy, expected);
    assert.ok(Number.isSafeInteger(legacy));
    assert.ok(legacy < 0x700000000000);
  });
});

