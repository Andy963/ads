import {
  ACOPILOT_LANE_ID,
  ACTIONS_LANE_ID,
  normalizeLaneId,
  type CanonicalLaneId,
} from "../../../shared/terminology.js";

/**
 * Chat session ids as they travel over the WebSocket.
 *
 * The wire vocabulary is still the legacy pair. The server routes a lane with
 * `chatSessionId === "advisor" ? acopilot : actions`, so any value that is not
 * exactly "advisor" falls through to the Actions lane. Sending "acopilot"
 * today would therefore route Acopilot traffic into Actions -- silently, with
 * no error. Migrating the server side of this routing is a later slice; until
 * then this module is the single place where a canonical lane is translated to
 * and from the value the server expects.
 *
 * Keep every legacy chat-session literal in this file. Nothing else in the
 * client should spell "advisor" or "worker" as a lane value.
 */
export type WireChatSessionId = "advisor" | "worker";

const WIRE_CHAT_SESSION_IDS: Readonly<Record<CanonicalLaneId, WireChatSessionId>> = {
  [ACOPILOT_LANE_ID]: "advisor",
  // The Actions lane does not actually transmit a lane id on the wire: it
  // sends the project's own session id (or "main"). This entry keeps the map
  // total so canonical<->wire translation is symmetric and exhaustively typed;
  // it has no production caller until the server routing slice lands.
  [ACTIONS_LANE_ID]: "worker",
};

/**
 * The wire chat session id for the Acopilot lane.
 *
 * Exported so call sites that must recognise the shared Acopilot session
 * compare against this instead of repeating the legacy literal.
 */
export const WIRE_ACOPILOT_SESSION_ID: WireChatSessionId = "advisor";

/**
 * The wire chat session id for a canonical lane.
 *
 * The current production path only ever needs the Acopilot lane, so callers
 * use the WIRE_ACOPILOT_SESSION_ID constant directly. This generic translator
 * is reserved for the server-migration slice, which will need canonical->wire
 * for arbitrary lanes once the server accepts canonical ids; today it is
 * covered only by the round-trip test in laneWire.test.ts.
 */
export function toWireChatSessionId(lane: CanonicalLaneId): WireChatSessionId {
  return WIRE_CHAT_SESSION_IDS[lane];
}

/**
 * Resolve a received chat session id to a canonical lane.
 *
 * Returns null for anything that is not a lane, including the "main" session
 * id used by the Actions lane, so callers must not treat a null result as an
 * error.
 *
 * Reserved for the inbound-message slice: not yet called from src, so the
 * only coverage today is the round-trip test in laneWire.test.ts.
 */
export function fromWireChatSessionId(value: unknown): CanonicalLaneId | null {
  return normalizeLaneId(value);
}

/**
 * True when a chat session id denotes a top-level lane rather than a project
 * session. Reserved for the inbound-message slice (see fromWireChatSessionId).
 */
export function isWireLaneSessionId(value: unknown): boolean {
  return fromWireChatSessionId(value) !== null;
}
