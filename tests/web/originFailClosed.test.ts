import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";

import { isOriginAllowedForRequest, parseAllowedOrigins } from "../../server/web/auth/origin.js";

function req(headers: Record<string, string | undefined>): { headers: http.IncomingHttpHeaders } {
  return { headers: headers as http.IncomingHttpHeaders };
}

describe("web/auth/origin fail-closed", () => {
  describe("no allowlist configured", () => {
    const allowed = parseAllowedOrigins(undefined);

    it("allows requests with no Origin header (non-browser clients)", () => {
      assert.equal(isOriginAllowedForRequest(req({ host: "example.com" }), allowed), true);
    });

    it("allows same-origin requests (Origin hostname == Host hostname)", () => {
      assert.equal(
        isOriginAllowedForRequest(req({ origin: "https://example.com", host: "example.com" }), allowed),
        true,
      );
    });

    it("ignores scheme and port when comparing hostnames", () => {
      assert.equal(
        isOriginAllowedForRequest(req({ origin: "http://example.com:3000", host: "example.com:8787" }), allowed),
        true,
      );
    });

    it("rejects cross-site requests", () => {
      assert.equal(
        isOriginAllowedForRequest(req({ origin: "https://evil.example", host: "example.com" }), allowed),
        false,
      );
    });

    it("allows localhost / loopback origins", () => {
      assert.equal(isOriginAllowedForRequest(req({ origin: "http://localhost:5173", host: "example.com" }), allowed), true);
      assert.equal(isOriginAllowedForRequest(req({ origin: "http://127.0.0.1:5173", host: "example.com" }), allowed), true);
    });

    it("rejects a malformed Origin header", () => {
      assert.equal(isOriginAllowedForRequest(req({ origin: "not-a-url", host: "example.com" }), allowed), false);
    });
  });

  describe("allowlist configured", () => {
    const allowed = parseAllowedOrigins("https://app.example.com");

    it("allows an exact allowlisted Origin", () => {
      assert.equal(
        isOriginAllowedForRequest(req({ origin: "https://app.example.com", host: "anything" }), allowed),
        true,
      );
    });

    it("rejects an Origin not on the allowlist even if same-origin", () => {
      assert.equal(
        isOriginAllowedForRequest(req({ origin: "https://app.example.com.evil", host: "app.example.com.evil" }), allowed),
        false,
      );
    });

    it("rejects a missing Origin when an allowlist is configured", () => {
      assert.equal(isOriginAllowedForRequest(req({ host: "app.example.com" }), allowed), false);
    });

    it("honors the wildcard allowlist", () => {
      const star = parseAllowedOrigins("*");
      assert.equal(isOriginAllowedForRequest(req({ origin: "https://whatever.example", host: "x" }), star), true);
    });
  });
});
