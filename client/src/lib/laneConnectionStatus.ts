import type { ChatLane } from "../composables/app/useLaneRuntimeBridge";

export type WorkspaceTab = ChatLane;

export function isLaneConnected(
  tab: WorkspaceTab,
  states: { acopilot: boolean; actions: boolean },
): boolean {
  if (tab === "acopilot") return states.acopilot;
  if (tab === "actions") return states.actions;
  return false;
}
