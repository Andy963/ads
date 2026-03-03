import { describe, expect, it } from "vitest";

import { encodeBase64Url } from "./base64url";

function encodeExpected(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("encodeBase64Url", () => {
  it("encodes ascii", () => {
    expect(encodeBase64Url("hello")).toBe("aGVsbG8");
  });

  it("encodes utf8", () => {
    const input = "✓ à la mode";
    expect(encodeBase64Url(input)).toBe(encodeExpected(input));
  });

  it("encodes long inputs without truncation", () => {
    const input = "a".repeat(0x8000 + 10);
    expect(encodeBase64Url(input)).toBe(encodeExpected(input));
  });
});

