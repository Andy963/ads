import type { ChatLane } from "../composables/app/useLaneRuntimeBridge";

export type WorkspaceTab = "tasks" | ChatLane;

export function isLaneConnected(
  tab: WorkspaceTab,
  states: { planner: boolean; worker: boolean },
): boolean {
  if (tab === "planner") return states.planner;
  if (tab === "worker") return states.worker;
  return false;
}
