import { describe, expect, it } from "vitest";

import { ref } from "vue";

import { resolveLaneConnectionPhase, setLaneSyncInProgress, touchLaneConnectionPhase } from "./laneConnectionPhase";

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
    expect(resolveLaneConnectionPhase({ ...base, reconnectActive: true })).toBe("reconnecting");
  });

  it("gives terminal errors precedence over stale reconnect state", () => {
    expect(resolveLaneConnectionPhase({ ...base, terminalError: "Unauthorized" })).toBe("error");
    expect(resolveLaneConnectionPhase({ ...base, reconnectActive: true, terminalError: "Unauthorized" })).toBe("error");
  });

  it("returns no phase once the lane is ready", () => {
    expect(resolveLaneConnectionPhase({
      ...base,
      connected: true,
      transcriptAuthoritative: true,
    })).toBeNull();
  });

  it("bumps a reactive revision when non-ref connection state changes", () => {
    const state = {
      syncInProgress: false,
      connectionPhaseRevision: ref(0),
    };
    setLaneSyncInProgress(state, true);
    expect(state.syncInProgress).toBe(true);
    expect(state.connectionPhaseRevision.value).toBe(1);
    touchLaneConnectionPhase(state);
    expect(state.connectionPhaseRevision.value).toBe(2);
  });
});
