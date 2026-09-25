import { normalizeLaneId, type CanonicalLaneId } from "../../../shared/terminology.js";
import { readMobileTabPreference, writeMobileTabPreference } from "./preferencesStore.js";

/**
 * The lane shown by default on a narrow viewport.
 *
 * Stored values predate the terminology migration and can still be `planner`,
 * `advisor` or `worker`, so reads resolve them through the shared contract
 * rather than accepting the new spellings only. Writes are always canonical.
 */
export type MobileWorkspaceTab = CanonicalLaneId;

const DEFAULT_MOBILE_WORKSPACE_TAB: MobileWorkspaceTab = "acopilot";

function normalizeProjectId(projectId: unknown): string {
  const normalized = typeof projectId === "string" ? projectId.trim() : String(projectId ?? "").trim();
  return normalized;
}

export function normalizeMobileWorkspaceTab(value: unknown): MobileWorkspaceTab {
  return normalizeLaneId(value) ?? DEFAULT_MOBILE_WORKSPACE_TAB;
}

export function readMobileWorkspaceTab(projectId: string): MobileWorkspaceTab {
  if (!normalizeProjectId(projectId)) return DEFAULT_MOBILE_WORKSPACE_TAB;
  try {
    return normalizeMobileWorkspaceTab(readMobileTabPreference(projectId));
  } catch {
    return DEFAULT_MOBILE_WORKSPACE_TAB;
  }
}

export function writeMobileWorkspaceTab(projectId: string, tab: MobileWorkspaceTab): void {
  if (!normalizeProjectId(projectId)) return;
  try {
    writeMobileTabPreference(projectId, normalizeMobileWorkspaceTab(tab));
  } catch {
    // Preferences are best-effort and must not block navigation.
  }
}
