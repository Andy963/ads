import type { Database as DatabaseType } from "better-sqlite3";

import { BASE_LANE_PROMPTS, LANE_NAMES, type LaneName, isLaneName } from "./lanePromptDefaults.js";

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

function validateLane(value: unknown): LaneName {
  const lane = String(value ?? "").trim().toLowerCase();
  if (!isLaneName(lane)) {
    throw new Error(`Unknown lane: ${lane || "empty"}`);
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

function toVersion(row: Record<string, unknown>): LanePromptVersion {
  return {
    lane: validateLane(row.lane),
    version: Number(row.version),
    prompt: String(row.prompt ?? ""),
    isBase: Number(row.is_base) === 1,
    createdAt: Number(row.created_at),
  };
}

export function ensureLanePromptTables(db: DatabaseType, now = Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lane_system_prompt_versions (
      lane TEXT NOT NULL CHECK (lane IN ('advisor', 'worker')),
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
      lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
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
  ensureLanePromptTables(db);

  const listVersionsStmt = db.prepare(`
    SELECT lane, version, prompt, is_base, created_at
    FROM lane_system_prompt_versions
    WHERE lane = ?
    ORDER BY version DESC
  `);
  const getCurrentVersionStmt = db.prepare(`
    SELECT v.lane, v.version, v.prompt, v.is_base, v.created_at, s.updated_at
    FROM lane_system_prompt_state s
    JOIN lane_system_prompt_versions v
      ON v.lane = s.lane AND v.version = s.current_version
    WHERE s.lane = ?
    LIMIT 1
  `);
  const getBaseVersionStmt = db.prepare(`
    SELECT lane, version, prompt, is_base, created_at
    FROM lane_system_prompt_versions
    WHERE lane = ? AND is_base = 1
    LIMIT 1
  `);
  const getMaxVersionStmt = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS max_version
    FROM lane_system_prompt_versions
    WHERE lane = ?
  `);
  const insertVersionStmt = db.prepare(`
    INSERT INTO lane_system_prompt_versions
      (lane, version, prompt, is_base, created_at)
    VALUES (?, ?, ?, 0, ?)
  `);
  const updateCurrentStmt = db.prepare(`
    UPDATE lane_system_prompt_state
    SET current_version = ?, updated_at = ?
    WHERE lane = ?
  `);

  const getSnapshot = (rawLane: unknown): LanePromptSnapshot => {
    const lane = validateLane(rawLane);
    const currentRow = getCurrentVersionStmt.get(lane) as Record<string, unknown> | undefined;
    const baseRow = getBaseVersionStmt.get(lane) as Record<string, unknown> | undefined;
    if (!currentRow || !baseRow) {
      throw new Error(`Lane prompt is not initialized: ${lane}`);
    }
    return {
      lane,
      current: toVersion(currentRow),
      base: toVersion(baseRow),
      versions: (listVersionsStmt.all(lane) as Record<string, unknown>[]).map(toVersion),
      updatedAt: Number(currentRow.updated_at ?? 0),
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
    const tx = db.transaction(() => {
      const row = getMaxVersionStmt.get(lane) as { max_version?: unknown } | undefined;
      const nextVersion = Number(row?.max_version ?? 0) + 1;
      insertVersionStmt.run(lane, nextVersion, prompt, now);
      const updated = updateCurrentStmt.run(nextVersion, now, lane) as { changes?: number };
      if (Number(updated.changes ?? 0) !== 1) {
        throw new Error(`Lane prompt state is not initialized: ${lane}`);
      }
    });
    tx();
    return getSnapshot(lane);
  };

  const resetLanePrompt = (rawLane: unknown): LanePromptSnapshot => {
    const lane = validateLane(rawLane);
    const base = getBaseVersionStmt.get(lane) as Record<string, unknown> | undefined;
    if (!base) {
      throw new Error(`Lane prompt base version is not initialized: ${lane}`);
    }
    const tx = db.transaction(() => {
      updateCurrentStmt.run(Number(base.version), Date.now(), lane);
    });
    tx();
    return getSnapshot(lane);
  };

  return { getLanePrompt, listLanePrompts, getActiveLanePrompt, setLanePrompt, resetLanePrompt };
}

export type LanePromptStore = ReturnType<typeof createLanePromptStore>;
