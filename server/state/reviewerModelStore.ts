import type { Database as DatabaseType } from "better-sqlite3";

import type { ReviewerModelSelection } from "../tasks/types.js";

/**
 * @deprecated Decommissioned per Issue #133. Retained for backward compatibility
 * without dropping the underlying table per database safety rules.
 */
export function createReviewerModelStore(
  db: DatabaseType,
  _modelStore?: unknown,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewer_model_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_config_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  return {
    getReviewerModelConfigId: (): string | null => null,
    getConfiguredReviewerModel: (): ReviewerModelSelection | null => null,
    setReviewerModel: (_modelConfigId: string | null, _now?: number): ReviewerModelSelection | null => null,
  };
}

export type ReviewerModelStore = ReturnType<typeof createReviewerModelStore>;
