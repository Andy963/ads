export type MobileWorkspaceTab = "tasks" | "planner" | "worker";

const MOBILE_WORKSPACE_TAB_KEY_PREFIX = "ads.mobileWorkspaceTab";
const DEFAULT_MOBILE_WORKSPACE_TAB: MobileWorkspaceTab = "planner";

function normalizeProjectId(projectId: unknown): string {
  const normalized = typeof projectId === "string" ? projectId.trim() : String(projectId ?? "").trim();
  return normalized;
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function buildMobileWorkspaceTabStorageKey(projectId: string): string {
  const normalized = normalizeProjectId(projectId);
  return `${MOBILE_WORKSPACE_TAB_KEY_PREFIX}.${normalized || "unknown"}`;
}

export function normalizeMobileWorkspaceTab(value: unknown): MobileWorkspaceTab {
  if (value === "tasks" || value === "planner" || value === "worker") return value;
  return DEFAULT_MOBILE_WORKSPACE_TAB;
}

export function readMobileWorkspaceTab(projectId: string): MobileWorkspaceTab {
  if (!normalizeProjectId(projectId)) return DEFAULT_MOBILE_WORKSPACE_TAB;
  const storage = getStorage();
  if (!storage) return DEFAULT_MOBILE_WORKSPACE_TAB;
  try {
    return normalizeMobileWorkspaceTab(storage.getItem(buildMobileWorkspaceTabStorageKey(projectId)));
  } catch {
    return DEFAULT_MOBILE_WORKSPACE_TAB;
  }
}

export function writeMobileWorkspaceTab(projectId: string, tab: MobileWorkspaceTab): void {
  if (!normalizeProjectId(projectId)) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(buildMobileWorkspaceTabStorageKey(projectId), normalizeMobileWorkspaceTab(tab));
  } catch {
    // Preferences are best-effort and must not block navigation.
  }
}
