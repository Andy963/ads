export type LaneConnectionPhase = "connecting" | "syncing" | "reconnecting" | "error";

export type LaneConnectionPhaseInput = {
  connected: boolean;
  transcriptAuthoritative: boolean;
  syncInProgress: boolean;
  reconnectActive: boolean;
  terminalError: string | null | undefined;
};

export function resolveLaneConnectionPhase(input: LaneConnectionPhaseInput): LaneConnectionPhase | null {
  if (input.reconnectActive) return "reconnecting";
  if (!input.connected) return String(input.terminalError ?? "").trim() ? "error" : "connecting";
  if (!input.transcriptAuthoritative || input.syncInProgress) return "syncing";
  return null;
}
