import {
  ACOPILOT_LANE_ID,
  ACTIONS_LANE_ID,
  normalizeLaneId,
  type CanonicalLaneId,
} from "../../../shared/terminology.js";

/**
 * Chat session ids as they travel over the WebSocket.
 *
 * The wire vocabulary is the canonical lane pair. The server resolves
 * `acopilot` to the Acopilot lane and routes everything else, including the
 * Actions lane's own project session ids, to Actions. The server also accepts
 * the retired `advisor` and `planner` spellings for older clients.
 *
 * Keep every retired chat-session literal in this file. Nothing else in the
 * client should spell "advisor" or "planner" as a lane value.
 */
export type WireChatSessionId = "acopilot" | "actions";

const WIRE_CHAT_SESSION_IDS: Readonly<Record<CanonicalLaneId, WireChatSessionId>> = {
  [ACOPILOT_LANE_ID]: "acopilot",
  // The Actions lane does not normally transmit a lane id on the wire: it
  // sends the project's own session id (or "main"). This entry keeps the map
  // total so canonical<->wire translation is symmetric and exhaustively typed.
  [ACTIONS_LANE_ID]: "actions",
};

/**
 * The wire chat session id for the Acopilot lane.
 *
 * Exported so call sites that must recognise the shared Acopilot session
 * compare against this instead of repeating the legacy literal.
 */
export const WIRE_ACOPILOT_SESSION_ID: WireChatSessionId = "acopilot";

/**
 * Retired wire spellings of the Acopilot lane chat session id, newest first.
 *
 * Browser storage keys written by older releases (outbox, pending prompt) are
 * keyed on these values, so upgrade read paths probe them in this order.
 */
export const RETIRED_ACOPILOT_WIRE_SESSION_IDS = ["advisor", "planner"] as const;

/**
 * The wire chat session id for a canonical lane.
 *
 * The current production path only ever needs the Acopilot lane, so callers
 * use the WIRE_ACOPILOT_SESSION_ID constant directly. This generic translator
 * is covered by the round-trip test in laneWire.test.ts.
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
