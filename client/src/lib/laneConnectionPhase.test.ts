import { describe, expect, it } from "vitest";

import { resolveLaneConnectionPhase } from "./laneConnectionPhase";

const base = {
  connected: false,
  transcriptAuthoritative: false,
  syncInProgress: false,
  reconnectActive: false,
  terminalError: null,
};

describe("lane connection phase", () => {
  it("reports connecting before the transport opens", () => {
    expect(resolveLaneConnectionPhase(base)).toBe("connecting");
  });

  it("reports syncing after the transport opens but before authoritative history", () => {
    expect(resolveLaneConnectionPhase({ ...base, connected: true })).toBe("syncing");
    expect(resolveLaneConnectionPhase({
      ...base,
      connected: true,
      transcriptAuthoritative: true,
      syncInProgress: true,
    })).toBe("syncing");
  });

  it("reports reconnecting while a retry is scheduled", () => {
    expect(resolveLaneConnectionPhase({ ...base, reconnectActive: true, terminalError: "socket closed" })).toBe("reconnecting");
  });

  it("reports terminal errors without treating scheduled reconnects as errors", () => {
    expect(resolveLaneConnectionPhase({ ...base, terminalError: "Unauthorized" })).toBe("error");
    expect(resolveLaneConnectionPhase({ ...base, reconnectActive: true, terminalError: "Unauthorized" })).toBe("reconnecting");
  });

  it("returns no phase once the lane is ready", () => {
    expect(resolveLaneConnectionPhase({
      ...base,
      connected: true,
      transcriptAuthoritative: true,
    })).toBeNull();
  });
});
