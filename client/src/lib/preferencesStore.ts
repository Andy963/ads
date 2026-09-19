// Centralized browser preference persistence.
//
// Fragmented per-lane/per-agent localStorage keys (`ads.modelId.*`,
// `ads.reasoningEffort.*`, `ads.mobileWorkspaceTab.*`, `ADS_WEB_LATEST_PROMPT:*`,
// `ads.laneGeneration.*`) are consolidated into a single JSON record per project
// under `ads.prefs.<projectId>`. Project list and navigation state live in a
// single `ads.app_state` record. Reads lazily migrate legacy keys into the new
// records and delete the legacy keys, so existing users keep their preferences
// without data loss. Large scoped buffers (`ads.transcript.v1.*`, `ads.outbox.*`,
// `__ads_runtime_diagnostics__`, `ads_pwa_reload_log`) intentionally stay
// partitioned to avoid serialization overhead and keep safety isolation.

import { normalizeLaneId } from "./laneIds.js";

export const PROJECT_PREFERENCES_STORAGE_PREFIX = "ads.prefs.";
export const APP_STATE_STORAGE_KEY = "ads.app_state";
export const PROJECT_PREFERENCES_VERSION = 1;
export const APP_STATE_VERSION = 1;

/** Agent key used for lane-wide model entries that are not scoped to a specific agent. */
export const LANE_DEFAULT_AGENT_KEY = "default";

const LEGACY_MODEL_KEY_PREFIX = "ads.modelId.";
const LEGACY_EFFORT_KEY_PREFIX = "ads.reasoningEffort.";
const LEGACY_MOBILE_TAB_KEY_PREFIX = "ads.mobileWorkspaceTab.";
const LEGACY_LATEST_PROMPT_KEY_PREFIX = "ADS_WEB_LATEST_PROMPT:";
const LEGACY_LANE_GENERATION_KEY_PREFIX = "ads.laneGeneration.";

const LEGACY_APP_STATE_KEYS = [
  "ADS_WEB_PROJECTS",
  "ADS_WEB_ACTIVE_PROJECT",
  "ADS_WEB_LAST_REAL_PROJECT",
  "ADS_WEB_LAST_REAL_PROJECT_TAB",
] as const;

export type AgentModelPreference = {
  modelId?: string;
  effort?: string;
};

export type ProjectPreferences = {
  version: number;
  updatedAt: number;
  mobileTab?: string;
  models?: Record<string, Record<string, AgentModelPreference>>;
  latestPrompts?: Record<string, string>;
  laneGenerations?: Record<string, number>;
};

export type AppNavigationState = {
  version: number;
  updatedAt: number;
  projects?: unknown;
  activeProject?: string | null;
  lastRealProject?: string | null;
  lastRealProjectTab?: unknown;
};

export type AppNavigationStateInput = {
  projects?: unknown;
  activeProject?: string | null;
  lastRealProject?: string | null;
  lastRealProjectTab?: unknown;
};

function normalizeProjectId(projectId: unknown): string {
  return typeof projectId === "string" ? projectId.trim() : String(projectId ?? "").trim();
}

function normalizeKeySegment(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || fallback;
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readRawValue(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildProjectPreferencesStorageKey(projectId: string): string {
  return `${PROJECT_PREFERENCES_STORAGE_PREFIX}${normalizeKeySegment(projectId, "unknown")}`;
}

function newProjectPreferences(): ProjectPreferences {
  return { version: PROJECT_PREFERENCES_VERSION, updatedAt: Date.now() };
}

function newAppNavigationState(): AppNavigationState {
  return { version: APP_STATE_VERSION, updatedAt: Date.now() };
}

function hasProjectPreferenceContent(prefs: ProjectPreferences): boolean {
  return Boolean(
    prefs.mobileTab ||
      (prefs.models && Object.keys(prefs.models).length > 0) ||
      (prefs.latestPrompts && Object.keys(prefs.latestPrompts).length > 0) ||
      (prefs.laneGenerations && Object.keys(prefs.laneGenerations).length > 0),
  );
}

function normalizeAgentPreference(value: unknown): AgentModelPreference | null {
  if (!isRecord(value)) return null;
  const pref: AgentModelPreference = {};
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (modelId) pref.modelId = modelId;
  const effort = typeof value.effort === "string" ? value.effort.trim() : "";
  if (effort) pref.effort = effort;
  return Object.keys(pref).length > 0 ? pref : null;
}

function normalizePreferences(value: unknown): ProjectPreferences | null {
  if (!isRecord(value)) return null;
  const updatedAt = Number(value.updatedAt);
  const prefs: ProjectPreferences = {
    version: PROJECT_PREFERENCES_VERSION,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
  const mobileTab = typeof value.mobileTab === "string" ? value.mobileTab.trim() : "";
  if (mobileTab) prefs.mobileTab = mobileTab;
  if (isRecord(value.models)) {
    const models: Record<string, Record<string, AgentModelPreference>> = {};
    for (const [rawLane, rawAgents] of Object.entries(value.models)) {
      const lane = normalizeLaneId(rawLane);
      if (!lane || !isRecord(rawAgents)) continue;
      const agents: Record<string, AgentModelPreference> = {};
      for (const [rawAgent, rawPref] of Object.entries(rawAgents)) {
        const agent = normalizeKeySegment(rawAgent, "");
        const pref = normalizeAgentPreference(rawPref);
        if (agent && pref) agents[agent] = pref;
      }
      if (Object.keys(agents).length > 0) models[lane] = agents;
    }
    if (Object.keys(models).length > 0) prefs.models = models;
  }
  if (isRecord(value.latestPrompts)) {
    const latestPrompts: Record<string, string> = {};
    for (const [rawLane, rawPrompt] of Object.entries(value.latestPrompts)) {
      const lane = normalizeLaneId(rawLane);
      const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
      if (lane && prompt) latestPrompts[lane] = prompt;
    }
    if (Object.keys(latestPrompts).length > 0) prefs.latestPrompts = latestPrompts;
  }
  if (isRecord(value.laneGenerations)) {
    const laneGenerations: Record<string, number> = {};
    for (const [rawLane, rawGeneration] of Object.entries(value.laneGenerations)) {
      const lane = normalizeLaneId(rawLane);
      const generation = Number(rawGeneration);
      if (lane && Number.isFinite(generation) && generation >= 1) {
        laneGenerations[lane] = Math.floor(generation);
      }
    }
    if (Object.keys(laneGenerations).length > 0) prefs.laneGenerations = laneGenerations;
  }
  return prefs;
}

function normalizeAppNavigationState(value: unknown): AppNavigationState | null {
  if (!isRecord(value)) return null;
  const updatedAt = Number(value.updatedAt);
  const state = newAppNavigationState();
  state.updatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
  if (Array.isArray(value.projects)) state.projects = value.projects;
  else if (value.projects === null) state.projects = null;
  if (typeof value.activeProject === "string") {
    state.activeProject = value.activeProject.trim() || null;
  } else if (value.activeProject === null || value.activeProject === undefined) {
    state.activeProject = null;
  }
  if (typeof value.lastRealProject === "string") {
    state.lastRealProject = value.lastRealProject.trim() || null;
  } else if (value.lastRealProject === null || value.lastRealProject === undefined) {
    state.lastRealProject = null;
  }
  if ("lastRealProjectTab" in value) state.lastRealProjectTab = value.lastRealProjectTab ?? null;
  return state;
}

/**
 * Insert a legacy value keyed by its normalized lane. The canonical lane id
 * ("advisor") wins over the legacy "planner" variant when both are present.
 */
function insertLegacyValue<T>(
  target: Map<string, { laneRaw: string; value: T }>,
  laneKey: string,
  laneRaw: string,
  value: T,
): void {
  const existing = target.get(laneKey);
  if (existing && (existing.laneRaw === laneRaw || laneRaw === "planner")) return;
  target.set(laneKey, { laneRaw, value });
}

function migrateLegacyProjectPreferences(storage: Storage, projectId: string): ProjectPreferences {
  const prefs = newProjectPreferences();
  const consumedKeys: string[] = [];
  const models = new Map<string, Record<string, AgentModelPreference>>();
  const modelValues = new Map<string, { laneRaw: string; value: string }>();
  const effortValues = new Map<string, { laneRaw: string; value: string }>();
  const latestPromptValues = new Map<string, { laneRaw: string; value: string }>();
  const laneGenerationValues = new Map<string, { laneRaw: string; value: number }>();

  const splitLegacyLaneKey = (key: string, prefix: string): { laneRaw: string; agent: string } | null => {
    const rest = key.slice(prefix.length);
    if (!rest.startsWith(`${projectId}.`)) return null;
    const tail = rest.slice(projectId.length + 1);
    if (!tail) return null;
    const segments = tail.split(".");
    const laneRaw = segments[0]!.trim();
    if (!laneRaw) return null;
    const agent = normalizeKeySegment(segments.slice(1).join("."), LANE_DEFAULT_AGENT_KEY);
    return { laneRaw, agent };
  };

  for (const key of Object.keys(storage)) {
    let scoped: { laneRaw: string; agent: string } | null = null;
    if (key.startsWith(LEGACY_MODEL_KEY_PREFIX)) {
      scoped = splitLegacyLaneKey(key, LEGACY_MODEL_KEY_PREFIX);
      if (scoped) {
        const value = readRawValue(storage, key);
        const laneKey = normalizeLaneId(scoped.laneRaw) || "main";
        if (value !== null) {
          insertLegacyValue(modelValues, `${laneKey}::${scoped.agent}`, scoped.laneRaw, value.trim());
        }
        consumedKeys.push(key);
      }
      continue;
    }
    if (key.startsWith(LEGACY_EFFORT_KEY_PREFIX)) {
      scoped = splitLegacyLaneKey(key, LEGACY_EFFORT_KEY_PREFIX);
      if (scoped) {
        const value = readRawValue(storage, key);
        const laneKey = normalizeLaneId(scoped.laneRaw) || "main";
        if (value !== null) {
          insertLegacyValue(effortValues, `${laneKey}::${scoped.agent}`, scoped.laneRaw, value.trim());
        }
        consumedKeys.push(key);
      }
      continue;
    }
    if (key.startsWith(LEGACY_LANE_GENERATION_KEY_PREFIX)) {
      scoped = splitLegacyLaneKey(key, LEGACY_LANE_GENERATION_KEY_PREFIX);
      if (scoped && scoped.agent === LANE_DEFAULT_AGENT_KEY) {
        const value = Number(readRawValue(storage, key));
        if (Number.isFinite(value) && value >= 1) {
          const laneKey = normalizeLaneId(scoped.laneRaw) || "main";
          insertLegacyValue(laneGenerationValues, laneKey, scoped.laneRaw, Math.floor(value));
        }
        consumedKeys.push(key);
      }
      continue;
    }
    if (key.startsWith(LEGACY_LATEST_PROMPT_KEY_PREFIX)) {
      const rest = key.slice(LEGACY_LATEST_PROMPT_KEY_PREFIX.length);
      if (rest.startsWith(`${projectId}:`)) {
        const laneRaw = rest.slice(projectId.length + 1).trim();
        const value = readRawValue(storage, key);
        const laneKey = normalizeLaneId(laneRaw);
        if (laneKey && value !== null) {
          insertLegacyValue(latestPromptValues, laneKey, laneRaw, value.trim());
        }
        consumedKeys.push(key);
      }
      continue;
    }
    if (key === `${LEGACY_MOBILE_TAB_KEY_PREFIX}${projectId}`) {
      const value = readRawValue(storage, key);
      if (value !== null) prefs.mobileTab = value.trim() || undefined;
      consumedKeys.push(key);
    }
  }

  for (const [composite, entry] of modelValues) {
    if (!entry.value) continue;
    const sep = composite.indexOf("::");
    const lane = composite.slice(0, sep);
    const agent = composite.slice(sep + 2) || LANE_DEFAULT_AGENT_KEY;
    const agents = models.get(lane) ?? {};
    agents[agent] = { ...agents[agent], modelId: entry.value };
    models.set(lane, agents);
  }
  for (const [composite, entry] of effortValues) {
    if (!entry.value) continue;
    const sep = composite.indexOf("::");
    const lane = composite.slice(0, sep);
    const agent = composite.slice(sep + 2) || LANE_DEFAULT_AGENT_KEY;
    const agents = models.get(lane) ?? {};
    agents[agent] = { ...agents[agent], effort: entry.value };
    models.set(lane, agents);
  }
  if (models.size > 0) prefs.models = Object.fromEntries(models);

  const latestPrompts: Record<string, string> = {};
  for (const [lane, entry] of latestPromptValues) {
    if (!entry.value) continue;
    latestPrompts[lane] = entry.value;
  }
  if (Object.keys(latestPrompts).length > 0) prefs.latestPrompts = latestPrompts;

  const laneGenerations: Record<string, number> = {};
  for (const [lane, entry] of laneGenerationValues) {
    laneGenerations[lane] = entry.value;
  }
  if (Object.keys(laneGenerations).length > 0) prefs.laneGenerations = laneGenerations;

  try {
    for (const key of consumedKeys) storage.removeItem(key);
    if (hasProjectPreferenceContent(prefs)) {
      storage.setItem(buildProjectPreferencesStorageKey(projectId), JSON.stringify(prefs));
    }
  } catch {
    // Migration is best-effort; reads still succeed from the migrated in-memory value.
  }
  return prefs;
}

export function readProjectPreferences(projectId: string): ProjectPreferences {
  const pid = normalizeProjectId(projectId);
  const storage = getStorage();
  if (!pid || !storage) return newProjectPreferences();
  const key = buildProjectPreferencesStorageKey(pid);
  const parsed = normalizePreferences(safeJsonParse(readRawValue(storage, key)));
  if (parsed) return parsed;
  return migrateLegacyProjectPreferences(storage, pid);
}

function writePreferencesRecord(storage: Storage, key: string, prefs: ProjectPreferences): void {
  storage.setItem(
    key,
    JSON.stringify({ ...prefs, version: PROJECT_PREFERENCES_VERSION, updatedAt: Date.now() }),
  );
}

export function writeProjectPreferences(projectId: string, prefs: ProjectPreferences): void {
  const pid = normalizeProjectId(projectId);
  const storage = getStorage();
  if (!pid || !storage) return;
  try {
    writePreferencesRecord(storage, buildProjectPreferencesStorageKey(pid), prefs);
  } catch {
    // Preferences are best-effort and must not block the caller.
  }
}

function updateProjectPreferences(
  projectId: string,
  mutate: (prefs: ProjectPreferences) => boolean,
): void {
  const prefs = readProjectPreferences(projectId);
  if (!mutate(prefs)) return;
  writeProjectPreferences(projectId, prefs);
}

function resolvePreferenceLane(lane: unknown): string {
  return normalizeLaneId(lane);
}

export function readModelPreference(projectId: string, lane: string, agentId?: string): AgentModelPreference {
  const laneKey = resolvePreferenceLane(lane);
  if (!laneKey) return {};
  const agentKey = normalizeKeySegment(agentId, "") || LANE_DEFAULT_AGENT_KEY;
  const prefs = readProjectPreferences(projectId);
  return prefs.models?.[laneKey]?.[agentKey] ?? {};
}

export function readModelIdPreference(projectId: string, lane: string, agentId?: string): string | null {
  const modelId = readModelPreference(projectId, lane, agentId).modelId;
  return typeof modelId === "string" && modelId ? modelId : null;
}

export function readReasoningEffortPreference(projectId: string, lane: string, agentId?: string): string | null {
  const effort = readModelPreference(projectId, lane, agentId).effort;
  return typeof effort === "string" && effort ? effort : null;
}

export function writeModelPreference(
  projectId: string,
  lane: string,
  agentId: string | undefined,
  values: AgentModelPreference,
): void {
  const laneKey = resolvePreferenceLane(lane);
  if (!laneKey) return;
  const agentKey = normalizeKeySegment(agentId, "") || LANE_DEFAULT_AGENT_KEY;
  updateProjectPreferences(projectId, (prefs) => {
    const models = { ...(prefs.models ?? {}) };
    const agents = { ...(models[laneKey] ?? {}) };
    const current: AgentModelPreference = { ...(agents[agentKey] ?? {}) };
    let changed = false;
    if (typeof values.modelId === "string") {
      const modelId = values.modelId.trim();
      if (modelId && current.modelId !== modelId) {
        current.modelId = modelId;
        changed = true;
      }
    }
    if (typeof values.effort === "string") {
      const effort = values.effort.trim();
      if (effort && current.effort !== effort) {
        current.effort = effort;
        changed = true;
      }
    }
    if (!changed) return false;
    agents[agentKey] = current;
    models[laneKey] = agents;
    prefs.models = models;
    return true;
  });
}

export function readLatestPromptPreference(projectId: string, lane: string): string | null {
  const laneKey = resolvePreferenceLane(lane);
  if (!laneKey) return null;
  const prefs = readProjectPreferences(projectId);
  const prompt = prefs.latestPrompts?.[laneKey];
  return typeof prompt === "string" && prompt ? prompt : null;
}

export function writeLatestPromptPreference(projectId: string, lane: string, prompt: string): void {
  const laneKey = resolvePreferenceLane(lane);
  const value = String(prompt ?? "").trim();
  if (!laneKey || !value) return;
  updateProjectPreferences(projectId, (prefs) => {
    const latestPrompts = { ...(prefs.latestPrompts ?? {}) };
    if (latestPrompts[laneKey] === value) return false;
    latestPrompts[laneKey] = value;
    prefs.latestPrompts = latestPrompts;
    return true;
  });
}

export function readLaneGenerationPreference(projectId: string, lane: string): number | null {
  const laneKey = resolvePreferenceLane(lane);
  if (!laneKey) return null;
  const prefs = readProjectPreferences(projectId);
  const value = Number(prefs.laneGenerations?.[laneKey]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

export function writeLaneGenerationPreference(projectId: string, lane: string, generation: number): void {
  const laneKey = resolvePreferenceLane(lane);
  if (!laneKey) return;
  const value = Number(generation);
  if (!Number.isFinite(value)) return;
  const next = Math.max(1, Math.floor(value));
  updateProjectPreferences(projectId, (prefs) => {
    const laneGenerations = { ...(prefs.laneGenerations ?? {}) };
    if (laneGenerations[laneKey] === next) return false;
    laneGenerations[laneKey] = next;
    prefs.laneGenerations = laneGenerations;
    return true;
  });
}

export function readMobileTabPreference(projectId: string): string | null {
  const prefs = readProjectPreferences(projectId);
  return typeof prefs.mobileTab === "string" && prefs.mobileTab ? prefs.mobileTab : null;
}

export function writeMobileTabPreference(projectId: string, tab: string): void {
  const value = String(tab ?? "").trim();
  if (!value) return;
  updateProjectPreferences(projectId, (prefs) => {
    if (prefs.mobileTab === value) return false;
    prefs.mobileTab = value;
    return true;
  });
}

function isLegacyProjectPreferenceKey(key: string, projectId: string): boolean {
  for (const prefix of [LEGACY_MODEL_KEY_PREFIX, LEGACY_EFFORT_KEY_PREFIX, LEGACY_LANE_GENERATION_KEY_PREFIX]) {
    if (key.startsWith(prefix)) {
      return key.slice(prefix.length).startsWith(`${projectId}.`);
    }
  }
  if (key.startsWith(LEGACY_LATEST_PROMPT_KEY_PREFIX)) {
    return key.slice(LEGACY_LATEST_PROMPT_KEY_PREFIX.length).startsWith(`${projectId}:`);
  }
  if (key.startsWith(LEGACY_MOBILE_TAB_KEY_PREFIX)) {
    return key === `${LEGACY_MOBILE_TAB_KEY_PREFIX}${projectId}`;
  }
  return false;
}

/**
 * Remove every preference record owned by a project: the consolidated
 * `ads.prefs.<projectId>` record plus any legacy scattered keys that were never
 * migrated (e.g. the project was deleted before its preferences were read).
 */
export function removeProjectPreferences(projectId: string): void {
  const pid = normalizeProjectId(projectId);
  const storage = getStorage();
  if (!pid || !storage) return;
  try {
    storage.removeItem(buildProjectPreferencesStorageKey(pid));
    for (const key of Object.keys(storage)) {
      if (isLegacyProjectPreferenceKey(key, pid)) storage.removeItem(key);
    }
  } catch {
    // Best-effort cleanup; orphaned keys must not block project removal.
  }
}

function mergePreferenceRecords<T>(base: Record<string, T> | undefined, next: Record<string, T> | undefined): Record<string, T> | undefined {
  const merged: Record<string, T> = { ...(base ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(next ?? {})) {
    if (merged[key] !== value) {
      merged[key] = value;
      changed = true;
    }
  }
  if (!changed && !base && !next) return undefined;
  return merged;
}

function mergeModels(
  base: ProjectPreferences["models"],
  next: ProjectPreferences["models"],
): ProjectPreferences["models"] {
  const merged: Record<string, Record<string, AgentModelPreference>> = { ...(base ?? {}) };
  for (const [lane, agents] of Object.entries(next ?? {})) {
    merged[lane] = { ...(merged[lane] ?? {}), ...agents };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Carry preferences across a project identity rewrite (e.g. the default
 * workspace merging into its server-resolved session id). Existing preferences
 * for the new identity win per-key conflicts; the old record and its legacy
 * keys are removed so no orphaned keys remain.
 */
export function renameProjectPreferences(oldProjectId: string, newProjectId: string): void {
  const oldPid = normalizeProjectId(oldProjectId);
  const newPid = normalizeProjectId(newProjectId);
  const storage = getStorage();
  if (!oldPid || !newPid || oldPid === newPid || !storage) return;
  const previous = readProjectPreferences(oldPid);
  const existing = readProjectPreferences(newPid);
  const merged: ProjectPreferences = {
    ...previous,
    mobileTab: existing.mobileTab ?? previous.mobileTab,
    models: mergeModels(previous.models, existing.models),
    latestPrompts: mergePreferenceRecords(previous.latestPrompts, existing.latestPrompts),
    laneGenerations: mergePreferenceRecords(previous.laneGenerations, existing.laneGenerations),
  };
  try {
    if (hasProjectPreferenceContent(merged)) {
      writePreferencesRecord(storage, buildProjectPreferencesStorageKey(newPid), merged);
    }
  } catch {
    // Best-effort; the old record is still removed below to avoid zombies.
  }
  removeProjectPreferences(oldPid);
}

/**
 * Strip recalled prompts from every project preference record (and any legacy
 * prompt keys). Used on auth transitions so private input never leaks across
 * accounts; model/tab/generation preferences are not private and are kept.
 */
export function purgeLatestPromptPreferences(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(PROJECT_PREFERENCES_STORAGE_PREFIX)) continue;
      const prefs = normalizePreferences(safeJsonParse(readRawValue(storage, key)));
      if (!prefs?.latestPrompts) continue;
      delete prefs.latestPrompts;
      if (hasProjectPreferenceContent(prefs)) {
        writePreferencesRecord(storage, key, prefs);
      } else {
        storage.removeItem(key);
      }
    }
    for (const key of Object.keys(storage)) {
      if (key.startsWith(LEGACY_LATEST_PROMPT_KEY_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Best-effort privacy cleanup.
  }
}

export function readAppNavigationState(): AppNavigationState {
  const storage = getStorage();
  if (!storage) return newAppNavigationState();
  const parsed = normalizeAppNavigationState(safeJsonParse(readRawValue(storage, APP_STATE_STORAGE_KEY)));
  if (parsed) return parsed;
  // Lazy migration from the legacy scattered navigation keys.
  const state = newAppNavigationState();
  try {
    const projectsRaw = readRawValue(storage, LEGACY_APP_STATE_KEYS[0]);
    const activeRaw = readRawValue(storage, LEGACY_APP_STATE_KEYS[1]);
    const lastRealRaw = readRawValue(storage, LEGACY_APP_STATE_KEYS[2]);
    const lastRealTabRaw = readRawValue(storage, LEGACY_APP_STATE_KEYS[3]);
    if (projectsRaw !== null) state.projects = safeJsonParse(projectsRaw);
    if (activeRaw !== null) state.activeProject = activeRaw.trim() || null;
    if (lastRealRaw !== null) state.lastRealProject = lastRealRaw.trim() || null;
    if (lastRealTabRaw !== null) state.lastRealProjectTab = safeJsonParse(lastRealTabRaw);
    writeAppNavigationState(state);
    for (const legacyKey of LEGACY_APP_STATE_KEYS) storage.removeItem(legacyKey);
  } catch {
    // Migration is best-effort; the in-memory state is still returned.
  }
  return state;
}

export function writeAppNavigationState(state: AppNavigationStateInput): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({
        version: APP_STATE_VERSION,
        updatedAt: Date.now(),
        projects: state.projects ?? [],
        activeProject: state.activeProject ?? null,
        lastRealProject: state.lastRealProject ?? null,
        lastRealProjectTab: state.lastRealProjectTab ?? null,
      }),
    );
  } catch {
    // Navigation state is best-effort and must not block the caller.
  }
}
