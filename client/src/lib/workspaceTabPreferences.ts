import { normalizeLaneId, type CanonicalLaneId } from "../../../shared/terminology.js";
import { readMobileTabPreference, writeMobileTabPreference } from "./preferencesStore.js";

/**
 * The lane remembered per project across both viewports and reloads.
 *
 * Stored values predate the terminology migration and can still be `planner`,
 * `advisor` or `worker`, so reads resolve them through the shared contract
 * rather than accepting the new spellings only. Writes are always canonical.
 * The localStorage field stays named `mobileTab` for backward compatibility
 * with records already persisted per project.
 */
export type WorkspaceTab = CanonicalLaneId;

const DEFAULT_WORKSPACE_TAB: WorkspaceTab = "acopilot";

function normalizeProjectId(projectId: unknown): string {
  const normalized = typeof projectId === "string" ? projectId.trim() : String(projectId ?? "").trim();
  return normalized;
}

export function normalizeWorkspaceTab(value: unknown): WorkspaceTab {
  return normalizeLaneId(value) ?? DEFAULT_WORKSPACE_TAB;
}

export function readWorkspaceTab(projectId: string): WorkspaceTab {
  if (!normalizeProjectId(projectId)) return DEFAULT_WORKSPACE_TAB;
  try {
    return normalizeWorkspaceTab(readMobileTabPreference(projectId));
  } catch {
    return DEFAULT_WORKSPACE_TAB;
  }
}

export function writeWorkspaceTab(projectId: string, tab: WorkspaceTab): void {
  if (!normalizeProjectId(projectId)) return;
  try {
    writeMobileTabPreference(projectId, normalizeWorkspaceTab(tab));
  } catch {
    // Preferences are best-effort and must not block navigation.
  }
}
