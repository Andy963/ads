import { describe, expect, it } from "vitest";

import {
  fromWireChatSessionId,
  isWireLaneSessionId,
  toWireChatSessionId,
} from "./laneWire";

describe("lane wire compatibility", () => {
  it("maps canonical lanes to the canonical wire ids", () => {
    // The server resolves `acopilot` to the Acopilot lane and routes every
    // other value to Actions, so these two strings are the contract.
    expect(toWireChatSessionId("acopilot")).toBe("acopilot");
    expect(toWireChatSessionId("actions")).toBe("actions");
  });

  it("resolves retired wire ids back to canonical lanes", () => {
    expect(fromWireChatSessionId("advisor")).toBe("acopilot");
    expect(fromWireChatSessionId("worker")).toBe("actions");
    expect(fromWireChatSessionId("planner")).toBe("acopilot");
  });

  it("treats a project session id as not a lane", () => {
    // The Actions lane also uses ordinary per-project session ids such as
    // "main"; those must not be mistaken for a lane.
    expect(fromWireChatSessionId("main")).toBeNull();
    expect(isWireLaneSessionId("main")).toBe(false);
    expect(isWireLaneSessionId("acopilot")).toBe(true);
    expect(isWireLaneSessionId("actions")).toBe(true);
    expect(isWireLaneSessionId("advisor")).toBe(true);
    expect(isWireLaneSessionId("worker")).toBe(true);
  });

  it("rejects values that denote no lane", () => {
    for (const value of ["", "   ", "telegram", "actions2", null, undefined, 42]) {
      expect(fromWireChatSessionId(value)).toBeNull();
    }
  });

  it("round-trips every canonical lane", () => {
    for (const lane of ["acopilot", "actions"] as const) {
      expect(fromWireChatSessionId(toWireChatSessionId(lane))).toBe(lane);
    }
  });

  it("emits only canonical or retired lane ids on the wire", () => {
    for (const lane of ["acopilot", "actions"] as const) {
      expect(isWireLaneSessionId(toWireChatSessionId(lane))).toBe(true);
    }
  });
});
