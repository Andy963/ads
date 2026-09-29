import type { Database as DatabaseType } from "better-sqlite3";

import { normalizeLaneId } from "../../shared/terminology.js";
import { BASE_LANE_PROMPTS, LANE_NAMES, type LaneName } from "./lanePromptDefaults.js";
import { ensureRoleProfiles, getDefaultRoleProfile, saveRoleProfile } from "./roleProfileStore.js";

export const MAX_LANE_PROMPT_LENGTH = 100_000;

export type LanePromptVersion = {
  lane: LaneName;
  version: number;
  prompt: string;
  isBase: boolean;
  createdAt: number;
};

export type LanePromptSnapshot = {
  lane: LaneName;
  current: LanePromptVersion;
  base: LanePromptVersion;
  versions: LanePromptVersion[];
  updatedAt: number;
};

export type ActiveLanePrompt = {
  lane: LaneName;
  version: number;
  prompt: string;
};

/**
 * Resolve any accepted lane input to its canonical id.
 *
 * Legacy `advisor` / `worker` / `planner` spellings are accepted on read and
 * resolved to the lane they denote, per the compatibility matrix. Everything
 * downstream -- and every write -- uses only the canonical value.
 */
function validateLane(value: unknown): LaneName {
  const lane = normalizeLaneId(value);
  if (!lane) {
    const raw = String(value ?? "").trim().toLowerCase();
    throw new Error(`Unknown lane: ${raw || "empty"}`);
  }
  return lane;
}

function validatePrompt(value: unknown): string {
  const prompt = String(value ?? "").trim();
  if (!prompt) {
    throw new Error("Prompt must not be empty");
  }
  if (prompt.length > MAX_LANE_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds the maximum length of ${MAX_LANE_PROMPT_LENGTH} characters`);
  }
  return prompt;
}

export function ensureLanePromptTables(db: DatabaseType, now = Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lane_system_prompt_versions (
      lane TEXT NOT NULL CHECK (lane IN ('acopilot', 'actions')),
      version INTEGER NOT NULL CHECK (version >= 1),
      prompt TEXT NOT NULL,
      is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (lane, version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_system_prompt_base
      ON lane_system_prompt_versions(lane)
      WHERE is_base = 1;

    CREATE TABLE IF NOT EXISTS lane_system_prompt_state (
      lane TEXT PRIMARY KEY CHECK (lane IN ('acopilot', 'actions')),
      current_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (lane, current_version)
        REFERENCES lane_system_prompt_versions(lane, version)
    );
  `);

  const stateColumns = db.prepare("PRAGMA table_info(lane_system_prompt_state)").all() as Array<{ name?: unknown }>;
  if (!stateColumns.some((column) => column.name === "updated_at")) {
    db.exec("ALTER TABLE lane_system_prompt_state ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  }

  const insertBase = db.prepare(`
    INSERT OR IGNORE INTO lane_system_prompt_versions
      (lane, version, prompt, is_base, created_at)
    VALUES (?, 1, ?, 1, ?)
  `);
  const insertState = db.prepare(`
    INSERT OR IGNORE INTO lane_system_prompt_state (lane, current_version, updated_at)
    VALUES (?, 1, ?)
  `);

  for (const lane of LANE_NAMES) {
    insertBase.run(lane, BASE_LANE_PROMPTS[lane], now);
    insertState.run(lane, now);
  }
}

export function createLanePromptStore(db: DatabaseType) {
  ensureRoleProfiles(db);
  // Compatibility facade for existing prompt consumers. It never persists
  // snapshots: both the editor and runtime read the same role profile.
  const getSnapshot = (rawLane: unknown): LanePromptSnapshot => {
    const lane = validateLane(rawLane);
    const profile = getDefaultRoleProfile(db, lane === "actions" ? "developer" : "acopilot");
    if (!profile) throw new Error(`Role prompt is not initialized: ${lane}`);
    const current = { lane, version: profile.version, prompt: profile.system_prompt, isBase: profile.system_prompt === BASE_LANE_PROMPTS[lane], createdAt: profile.updated_at };
    return {
      lane, current, base: { lane, version: 0, prompt: BASE_LANE_PROMPTS[lane], isBase: true, createdAt: 0 },
      versions: [current], updatedAt: profile.updated_at,
    };
  };

  const getLanePrompt = (lane: LaneName): LanePromptSnapshot => getSnapshot(lane);

  const listLanePrompts = (): LanePromptSnapshot[] => LANE_NAMES.map((lane) => getSnapshot(lane));

  const getActiveLanePrompt = (lane: LaneName): ActiveLanePrompt => {
    const snapshot = getSnapshot(lane);
    return {
      lane: snapshot.lane,
      version: snapshot.current.version,
      prompt: snapshot.current.prompt,
    };
  };

  const setLanePrompt = (rawLane: unknown, rawPrompt: unknown, now = Date.now()): LanePromptSnapshot => {
    const lane = validateLane(rawLane);
    const prompt = validatePrompt(rawPrompt);
    const profile = getDefaultRoleProfile(db, lane === "actions" ? "developer" : "acopilot");
    if (!profile) throw new Error(`Role prompt is not initialized: ${lane}`);
    saveRoleProfile(db, { ...profile, system_prompt: prompt, is_enabled: Boolean(profile.is_enabled), is_default: Boolean(profile.is_default) }, now);
    return getSnapshot(lane);
  };

  const resetLanePrompt = (rawLane: unknown): LanePromptSnapshot => {
    const lane = validateLane(rawLane);
    return setLanePrompt(lane, BASE_LANE_PROMPTS[lane]);
  };

  return { getLanePrompt, listLanePrompts, getActiveLanePrompt, setLanePrompt, resetLanePrompt };
}

export type LanePromptStore = ReturnType<typeof createLanePromptStore>;
