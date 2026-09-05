import type { SessionManager } from "../../../sessions/sessionManager.js";
import type { WsLogger } from "./deps.js";
import type { WsMessage } from "./schema.js";

type GoalAction = "pause" | "resume" | "clear";

const GOAL_MESSAGE_TYPES: Record<string, GoalAction> = {
  "goal:pause": "pause",
  "goal:resume": "resume",
  "goal:clear": "clear",
};

/**
 * Handle WS goal control messages. Returns `true` if the message was a goal
 * control type (regardless of success).
 */
export async function handleGoalControlMessage(args: {
  parsed: WsMessage;
  currentCwd: string;
  sessionManager: SessionManager;
  sendJson: (payload: unknown) => void;
  logger: Pick<WsLogger, "warn" | "info">;
  isLaneCurrent?: () => boolean;
}): Promise<boolean> {
  const isLaneCurrent = (): boolean => args.isLaneCurrent ? args.isLaneCurrent() : true;
  const action = GOAL_MESSAGE_TYPES[args.parsed.type];
  if (!action) {
    return false;
  }
  if (!isLaneCurrent()) {
    return true;
  }

  args.sendJson({ type: "error", message: "Goal controls are no longer supported; use the active chat lane." });
  return true;
}
