import type { Database as DatabaseType } from "better-sqlite3";

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  credentialProfile?: string | null;
  wireApi?: string | null;
  isEnabled: boolean;
  updatedAt?: number | null;
}

function toModelProvider(row: Record<string, unknown>): ModelProvider {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    baseUrl: String(row.base_url ?? ""),
    credentialProfile: String(row.credential_profile ?? "").trim() || null,
    wireApi: String(row.wire_api ?? "").trim() || null,
    isEnabled: Boolean(row.is_enabled),
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : null,
  };
}

/**
 * First-class provider entity: a named upstream base URL plus a reference to
 * an encrypted credential profile in the upstream credential store. Model
 * configs attach to a provider via `model_configs.provider_id`.
 */
export function createModelProviderStore(db: DatabaseType) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      credential_profile TEXT,
      wire_api TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    )
  `);

  const listStmt = db.prepare("SELECT * FROM model_providers ORDER BY updated_at DESC, name ASC");
  const getStmt = db.prepare("SELECT * FROM model_providers WHERE id = ? LIMIT 1");
  const upsertStmt = db.prepare(`
    INSERT INTO model_providers (id, name, base_url, credential_profile, wire_api, is_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      credential_profile = excluded.credential_profile,
      wire_api = excluded.wire_api,
      is_enabled = excluded.is_enabled,
      updated_at = excluded.updated_at
  `);
  const deleteStmt = db.prepare("DELETE FROM model_providers WHERE id = ?");
  // Prepared lazily: model_configs may not exist when the provider store is
  // created before the model config store.
  const detachModelsStmt = () => db.prepare("UPDATE model_configs SET provider_id = NULL WHERE provider_id = ?");

  const listProviders = (): ModelProvider[] => {
    const rows = listStmt.all() as Record<string, unknown>[];
    return rows.map((row) => toModelProvider(row));
  };

  const getProvider = (id: string): ModelProvider | null => {
    const normalized = String(id ?? "").trim();
    if (!normalized) return null;
    const row = getStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? toModelProvider(row) : null;
  };

  const upsertProvider = (provider: ModelProvider, now = Date.now()): ModelProvider => {
    const id = String(provider.id ?? "").trim();
    if (!id) throw new Error("model provider id is required");
    const name = String(provider.name ?? "").trim();
    if (!name) throw new Error("model provider name is required");
    const baseUrl = String(provider.baseUrl ?? "").trim();
    if (!baseUrl) throw new Error("model provider baseUrl is required");
    upsertStmt.run(
      id,
      name,
      baseUrl,
      String(provider.credentialProfile ?? "").trim() || null,
      String(provider.wireApi ?? "").trim() || null,
      provider.isEnabled ? 1 : 0,
      now,
    );
    const saved = getProvider(id);
    if (!saved) throw new Error("failed to load saved model provider");
    return saved;
  };

  /**
   * Delete a provider and detach (never drop) the model configs that
   * referenced it — their free-form provider string stays intact.
   */
  const deleteProvider = (id: string): boolean => {
    const normalized = String(id ?? "").trim();
    if (!normalized) return false;
    let deleted = false;
    const tx = db.transaction(() => {
      const res = deleteStmt.run(normalized) as { changes?: number };
      deleted = Number(res.changes ?? 0) > 0;
      if (deleted) {
        const configColumns = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name?: string }>;
        if (configColumns.some((column) => column.name === "provider_id")) {
          detachModelsStmt().run(normalized);
        }
      }
    });
    tx();
    return deleted;
  };

  return { db, listProviders, getProvider, upsertProvider, deleteProvider };
}

export type ModelProviderStore = ReturnType<typeof createModelProviderStore>;
