import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { serializeCookie } from "../../src/web/auth/cookies.js";

describe("web/auth/cookies", () => {
  it("serializeCookie should include security attributes by default", () => {
    const header = serializeCookie("ads_session", "t", { sameSite: "Lax", maxAgeSeconds: 60 });
    assert.match(header, /^ads_session=t;/);
    assert.ok(header.includes("HttpOnly"));
    assert.ok(header.includes("Secure"));
    assert.ok(header.includes("SameSite=Lax"));
    assert.ok(header.includes("Path=/"));
    assert.ok(header.includes("Max-Age=60"));
  });
});

