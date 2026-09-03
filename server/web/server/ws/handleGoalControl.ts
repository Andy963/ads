import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import type { WsLogger } from "./deps.js";
import type { WsMessage } from "./schema.js";

type GoalAction = "pause" | "resume" | "clear";

const GOAL_MESSAGE_TYPES: Record<string, GoalAction> = {
  "goal:pause": "pause",
  "goal:resume": "resume",
  "goal:clear": "clear",
};

function extractTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { taskId?: unknown; task_id?: unknown }).taskId ?? (payload as { task_id?: unknown }).task_id;
  const id = String(raw ?? "").trim();
  return id || null;
}

/**
 * Handle WS goal control messages. Returns `true` if the message was a goal
 * control type (regardless of success).
 */
export async function handleGoalControlMessage(args: {
  parsed: WsMessage;
  currentCwd: string;
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
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

  const taskId = extractTaskId(args.parsed.payload);
  if (!taskId) {
    args.sendJson({ type: "error", message: `${args.parsed.type} requires taskId` });
    return true;
  }

  const ensure = args.ensureTaskContext;
  if (!ensure) {
    args.sendJson({ type: "error", message: "task context unavailable" });
    return true;
  }

  let ctx: TaskQueueContext;
  try {
    ctx = ensure(args.currentCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.logger.warn(`[goal] ensureTaskContext failed: ${message}`);
    args.sendJson({ type: "error", message: `failed to resolve task context: ${message}` });
    return true;
  }

  const task = ctx.taskStore.getTask(taskId);
  if (!task) {
    args.sendJson({ type: "error", message: `task not found: ${taskId}` });
    return true;
  }
  if (!task.goalMode) {
    args.sendJson({ type: "error", message: `task ${taskId} is not in goal mode` });
    return true;
  }

  const orchestrator = ctx.getTaskQueueOrchestrator(task);
  // The orchestrator routes by agent id. Goal-mode tasks pin "codex".
  const adapter = (orchestrator as { getAdapter?: (id: string) => unknown }).getAdapter?.("codex");
  if (!adapter) {
    args.sendJson({ type: "error", message: "goal-mode adapter is not registered" });
    return true;
  }
  const goalAdapter = adapter as {
    setGoal?: (opts: { status?: "active" | "paused"; objective?: string; tokenBudget?: number | null }) => Promise<unknown>;
    clearGoal?: () => Promise<void>;
  };

  try {
    if (action === "clear") {
      if (typeof goalAdapter.clearGoal !== "function") {
        throw new Error("adapter does not support clearGoal");
      }
      await goalAdapter.clearGoal();
    } else {
      if (typeof goalAdapter.setGoal !== "function") {
        throw new Error("adapter does not support setGoal");
      }
      await goalAdapter.setGoal({ status: action === "pause" ? "paused" : "active" });
    }
    if (!isLaneCurrent()) {
      return true;
    }
    args.sendJson({ type: "result", ok: true, kind: args.parsed.type, taskId });
  } catch (err) {
    if (!isLaneCurrent()) {
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    args.logger.warn(`[goal] ${action} failed taskId=${taskId} err=${message}`);
    args.sendJson({ type: "error", message: `goal ${action} failed: ${message}` });
  }
  return true;
}
