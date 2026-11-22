export type LaneConnectionPhase = "connecting" | "syncing" | "reconnecting" | "error";

export type LaneConnectionPhaseInput = {
  connected: boolean;
  transcriptAuthoritative: boolean;
  syncInProgress: boolean;
  reconnectActive: boolean;
  terminalError: string | null | undefined;
  stateRevision?: number;
};

type LaneSyncState = {
  syncInProgress: boolean;
  connectionPhaseRevision: { value: number };
};

export function setLaneSyncInProgress(state: LaneSyncState, value: boolean): void {
  state.syncInProgress = value;
  state.connectionPhaseRevision.value += 1;
}

export function touchLaneConnectionPhase(state: { connectionPhaseRevision: { value: number } }): void {
  state.connectionPhaseRevision.value += 1;
}

export function resolveLaneConnectionPhase(input: LaneConnectionPhaseInput): LaneConnectionPhase | null {
  if (String(input.terminalError ?? "").trim()) return "error";
  if (input.reconnectActive) return "reconnecting";
  if (!input.connected) return "connecting";
  if (!input.transcriptAuthoritative || input.syncInProgress) return "syncing";
  return null;
}
