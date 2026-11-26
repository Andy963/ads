import { describe, expect, it } from "vitest";

import { ref } from "vue";

import { resolveLaneConnectionPhase, setLaneSyncInProgress, touchLaneConnectionPhase } from "./laneConnectionPhase";

const base = {
  connected: false,
  connecting: false,
  syncInProgress: false,
  reconnectActive: false,
  terminalError: null,
};

describe("lane connection phase", () => {
  it("does not report connection or sync activity while the transport is idle", () => {
    expect(resolveLaneConnectionPhase(base)).toBeNull();
  });

  it("reports connecting only while the transport handshake is active", () => {
    expect(resolveLaneConnectionPhase({ ...base, connecting: true })).toBe("connecting");
  });

  it("reports syncing only for an active sync on an open transport", () => {
    expect(resolveLaneConnectionPhase({ ...base, connected: true, syncInProgress: true })).toBe("syncing");
    expect(resolveLaneConnectionPhase({
      ...base,
      connected: true,
      syncInProgress: false,
    })).toBeNull();
    expect(resolveLaneConnectionPhase({ ...base, syncInProgress: true })).toBeNull();
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
