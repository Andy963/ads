import { describe, expect, it } from "vitest";

import { laneIdVariants, normalizeLaneId } from "./laneIds";

/**
 * The client's lane helper is deliberately more permissive than the shared
 * contract: unknown lanes pass through instead of being rejected, because
 * preferencesStore keys storage off the result. These tests pin that behaviour
 * against the exact implementation that shipped before the shared contract was
 * introduced, so extracting the vocabulary cannot silently change storage keys.
 */
describe("client laneIds compatibility", () => {
  it("resolves canonical ids and every legacy alias", () => {
    expect(normalizeLaneId("acopilot")).toBe("acopilot");
    expect(normalizeLaneId("actions")).toBe("actions");
    expect(normalizeLaneId("advisor")).toBe("acopilot");
    expect(normalizeLaneId("planner")).toBe("acopilot");
    expect(normalizeLaneId("worker")).toBe("actions");
  });

  it("trims before resolving", () => {
    expect(normalizeLaneId("  advisor  ")).toBe("acopilot");
    expect(normalizeLaneId("\tworker\n")).toBe("actions");
  });

  it("passes unknown and non-string input through as a string", () => {
    for (const value of ["", "   ", "planners", "REVIEWER", "Developer", "actions2"]) {
      expect(normalizeLaneId(value)).toBe(String(value).trim());
    }
    expect(normalizeLaneId(42)).toBe("42");
    expect(normalizeLaneId(true)).toBe("true");
    expect(normalizeLaneId(null)).toBe("");
    expect(normalizeLaneId(undefined)).toBe("");
  });

  it("never returns an inherited property instead of a string", () => {
    // Regression: indexing the alias table without an own-property guard made
    // these resolve to Object.prototype members, so the declared `string`
    // return type was false and a function got written as a storage key.
    const inherited = [
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    for (const key of inherited) {
      expect(normalizeLaneId(key)).toBe(key);
      expect(laneIdVariants(key)).toEqual([key]);
    }
  });

  it("orders lane variants canonical-first", () => {
    expect(laneIdVariants("acopilot")).toEqual(["acopilot", "advisor", "planner"]);
    expect(laneIdVariants("actions")).toEqual(["actions", "worker"]);
    expect(laneIdVariants("advisor")).toEqual(["acopilot", "advisor", "planner"]);
    expect(laneIdVariants("worker")).toEqual(["actions", "worker"]);
  });

  it("returns no variants for empty input", () => {
    expect(laneIdVariants("")).toEqual([]);
    expect(laneIdVariants("   ")).toEqual([]);
    expect(laneIdVariants(null)).toEqual([]);
    expect(laneIdVariants(undefined)).toEqual([]);
  });
});
