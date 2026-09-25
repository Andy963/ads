import { describe, expect, it } from "vitest";

import {
  fromWireChatSessionId,
  isWireLaneSessionId,
  toWireChatSessionId,
} from "./laneWire";

describe("lane wire compatibility", () => {
  it("maps canonical lanes to the legacy wire ids the server still expects", () => {
    // The server routes with `chatSessionId === "advisor" ? acopilot : actions`,
    // so these two exact strings are the contract. Sending anything else routes
    // Acopilot traffic into Actions.
    expect(toWireChatSessionId("acopilot")).toBe("advisor");
    expect(toWireChatSessionId("actions")).toBe("worker");
  });

  it("resolves received wire ids back to canonical lanes", () => {
    expect(fromWireChatSessionId("advisor")).toBe("acopilot");
    expect(fromWireChatSessionId("worker")).toBe("actions");
    // planner was the pre-rename spelling of the same lane.
    expect(fromWireChatSessionId("planner")).toBe("acopilot");
  });

  it("treats a project session id as not a lane", () => {
    // The Actions lane also uses ordinary per-project session ids such as
    // "main"; those must not be mistaken for a lane.
    expect(fromWireChatSessionId("main")).toBeNull();
    expect(isWireLaneSessionId("main")).toBe(false);
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

  it("never emits a canonical id on the wire", () => {
    // Guards the whole point of this module: if a canonical value ever leaked
    // into the wire vocabulary, the server would silently route it to Actions.
    for (const lane of ["acopilot", "actions"] as const) {
      expect(toWireChatSessionId(lane)).not.toBe(lane);
    }
  });
});
