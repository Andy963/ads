import { readMobileTabPreference, writeMobileTabPreference } from "./preferencesStore.js";

export type MobileWorkspaceTab = "advisor" | "worker";

const DEFAULT_MOBILE_WORKSPACE_TAB: MobileWorkspaceTab = "advisor";

function normalizeProjectId(projectId: unknown): string {
  const normalized = typeof projectId === "string" ? projectId.trim() : String(projectId ?? "").trim();
  return normalized;
}

export function normalizeMobileWorkspaceTab(value: unknown): MobileWorkspaceTab {
  // Map legacy and evolved tabs gracefully to current UI view tabs
  if (value === "planner" || value === "advisor" || value === "acopilot") return "advisor";
  if (value === "worker" || value === "actions") return "worker";
  if (value === "advisor" || value === "worker") return value;
  return DEFAULT_MOBILE_WORKSPACE_TAB;
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
    const normalized = normalizeMobileWorkspaceTab(tab);
    const canonical = normalized === "advisor" ? "acopilot" : "actions";
    writeMobileTabPreference(projectId, canonical);
  } catch {
    // Preferences are best-effort and must not block navigation.
  }
}
