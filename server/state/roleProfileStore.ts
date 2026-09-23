import type { Database as DatabaseType } from "better-sqlite3";

export type RoleType = "acopilot" | "developer" | "reviewer";
export type ReasoningEffortLevel = "low" | "medium" | "high";

export interface RoleProfileRecord {
  id: string;
  role: RoleType;
  name: string;
  model_id: string;
  reasoning_effort: ReasoningEffortLevel;
  system_prompt: string;
  is_enabled: number;
  is_default: number;
  version: number;
  updated_at: number;
}

export interface RoleSettingsHistoryRecord {
  id: number;
  role: RoleType;
  version: number;
  model_id: string;
  reasoning_effort: string;
  system_prompt: string;
  created_at: number;
}

export function getRoleProfiles(db: DatabaseType, role?: RoleType): RoleProfileRecord[] {
  if (role) {
    return db
      .prepare(`SELECT * FROM role_profiles WHERE role = ? ORDER BY is_default DESC, updated_at DESC`)
      .all(role) as RoleProfileRecord[];
  }
  return db
    .prepare(`SELECT * FROM role_profiles ORDER BY role ASC, is_default DESC, updated_at DESC`)
    .all() as RoleProfileRecord[];
}

export function getDefaultRoleProfile(db: DatabaseType, role: RoleType): RoleProfileRecord | null {
  const row = db
    .prepare(`SELECT * FROM role_profiles WHERE role = ? AND is_default = 1 LIMIT 1`)
    .get(role) as RoleProfileRecord | undefined;
  if (row) return row;
  return (db.prepare(`SELECT * FROM role_profiles WHERE role = ? LIMIT 1`).get(role) as RoleProfileRecord | undefined) ?? null;
}

export function saveRoleProfile(
  db: DatabaseType,
  profile: {
    id: string;
    role: RoleType;
    name: string;
    model_id: string;
    reasoning_effort?: ReasoningEffortLevel;
    system_prompt: string;
    is_enabled?: boolean;
    is_default?: boolean;
  },
  now = Date.now(),
): RoleProfileRecord {
  const effort = profile.reasoning_effort ?? "high";
  const enabled = profile.is_enabled !== false ? 1 : 0;
  const isDefault = profile.is_default ? 1 : 0;

  const existing = db.prepare(`SELECT * FROM role_profiles WHERE id = ?`).get(profile.id) as RoleProfileRecord | undefined;
  const nextVersion = existing ? existing.version + 1 : 1;

  if (isDefault === 1) {
    db.prepare(`UPDATE role_profiles SET is_default = 0 WHERE role = ?`).run(profile.role);
  }

  db.prepare(`
    INSERT INTO role_profiles
      (id, role, name, model_id, reasoning_effort, system_prompt, is_enabled, is_default, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      model_id = excluded.model_id,
      reasoning_effort = excluded.reasoning_effort,
      system_prompt = excluded.system_prompt,
      is_enabled = excluded.is_enabled,
      is_default = excluded.is_default,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(
    profile.id,
    profile.role,
    profile.name,
    profile.model_id,
    effort,
    profile.system_prompt,
    enabled,
    isDefault,
    nextVersion,
    now,
  );

  db.prepare(`
    INSERT INTO role_settings_history
      (role, version, model_id, reasoning_effort, system_prompt, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(profile.role, nextVersion, profile.model_id, effort, profile.system_prompt, now);

  return {
    id: profile.id,
    role: profile.role,
    name: profile.name,
    model_id: profile.model_id,
    reasoning_effort: effort,
    system_prompt: profile.system_prompt,
    is_enabled: enabled,
    is_default: isDefault,
    version: nextVersion,
    updated_at: now,
  };
}

export function getRoleSettingsHistory(db: DatabaseType, role: RoleType): RoleSettingsHistoryRecord[] {
  return db
    .prepare(`SELECT * FROM role_settings_history WHERE role = ? ORDER BY version DESC, id DESC`)
    .all(role) as RoleSettingsHistoryRecord[];
}

