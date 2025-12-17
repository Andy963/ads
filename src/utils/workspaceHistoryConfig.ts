export type WorkspaceHistorySearchEngine = "fts5" | "window-scan";

export interface WorkspaceHistoryConfig {
  lookbackTurns: number;
  maxChars: number;
  searchEngine: WorkspaceHistorySearchEngine;
  searchScanLimit: number;
  searchMaxResults: number;
  classifyEnabled: boolean;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  return undefined;
}

function parseSearchEngine(value: string | undefined): WorkspaceHistorySearchEngine | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "fts5") {
    return "fts5";
  }
  if (normalized === "window" || normalized === "window-scan" || normalized === "windowscan") {
    return "window-scan";
  }
  return undefined;
}

export function getWorkspaceHistoryConfig(): WorkspaceHistoryConfig {
  const lookbackTurns = parsePositiveInt(process.env.ADS_WORKSPACE_HISTORY_LOOKBACK_TURNS) ?? 100;
  const maxChars = parsePositiveInt(process.env.ADS_WORKSPACE_HISTORY_MAX_CHARS) ?? 2000;
  const searchEngine = parseSearchEngine(process.env.ADS_WORKSPACE_HISTORY_SEARCH_ENGINE) ?? "fts5";
  const searchScanLimit = parsePositiveInt(process.env.ADS_WORKSPACE_HISTORY_SEARCH_SCAN_LIMIT) ?? 5000;
  const searchMaxResults = parsePositiveInt(process.env.ADS_WORKSPACE_HISTORY_SEARCH_MAX_RESULTS) ?? 15;
  const classifyEnabled = parseBoolean(process.env.ADS_WORKSPACE_HISTORY_CLASSIFY) ?? true;

  return {
    lookbackTurns: Math.max(1, lookbackTurns),
    maxChars: Math.max(200, maxChars),
    searchEngine,
    searchScanLimit: Math.max(100, searchScanLimit),
    searchMaxResults: Math.max(1, searchMaxResults),
    classifyEnabled,
  };
}

