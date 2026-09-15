import type { ChatLane } from "../composables/app/useLaneRuntimeBridge";

export type WorkspaceTab = ChatLane;

export function isLaneConnected(
  tab: WorkspaceTab,
  states: { advisor: boolean; worker: boolean },
): boolean {
  if (tab === "advisor") return states.advisor;
  if (tab === "worker") return states.worker;
  return false;
}
