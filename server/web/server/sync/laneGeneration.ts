import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../../../state/database.js";

type SqliteStatement = StatementType<unknown[], unknown>;

export type LaneGenerationToken = {
  namespace: string;
  laneKey: string;
  generation: number;
};

export class WebLaneGenerationStore {
  private readonly db: DatabaseType;
  private readonly getStmt: SqliteStatement;
  private readonly insertStmt: SqliteStatement;
  private readonly bumpStmt: SqliteStatement;

  constructor(options: { stateDbPath?: string } = {}) {
    this.db = getStateDatabase(options.stateDbPath);
    this.getStmt = this.db.prepare(
      `SELECT generation
       FROM web_lane_generations
       WHERE namespace = ? AND lane_key = ?`,
    );
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO web_lane_generations (namespace, lane_key, generation, updated_at)
       VALUES (?, ?, 1, ?)`,
    );
    this.bumpStmt = this.db.prepare(
      `UPDATE web_lane_generations
       SET generation = generation + 1, updated_at = ?
       WHERE namespace = ? AND lane_key = ?`,
    );
  }

  getGeneration(namespace: string, laneKey: string): number {
    const normalizedNamespace = String(namespace ?? "").trim();
    const normalizedLaneKey = String(laneKey ?? "").trim();
    if (!normalizedNamespace || !normalizedLaneKey) {
      return 1;
    }

    const tx = this.db.transaction(() => {
      const now = Date.now();
      this.insertStmt.run(normalizedNamespace, normalizedLaneKey, now);
      const row = this.getStmt.get(normalizedNamespace, normalizedLaneKey) as { generation?: unknown } | undefined;
      const generation = Number(row?.generation);
      return Number.isFinite(generation) && generation >= 1 ? Math.floor(generation) : 1;
    });
    return tx();
  }

  bumpGeneration(namespace: string, laneKey: string): number {
    const normalizedNamespace = String(namespace ?? "").trim();
    const normalizedLaneKey = String(laneKey ?? "").trim();
    if (!normalizedNamespace || !normalizedLaneKey) {
      return 1;
    }

    const tx = this.db.transaction(() => {
      const now = Date.now();
      this.insertStmt.run(normalizedNamespace, normalizedLaneKey, now);
      this.bumpStmt.run(now, normalizedNamespace, normalizedLaneKey);
      const row = this.getStmt.get(normalizedNamespace, normalizedLaneKey) as { generation?: unknown } | undefined;
      const generation = Number(row?.generation);
      return Number.isFinite(generation) && generation >= 1 ? Math.floor(generation) : 1;
    });
    return tx();
  }

  capture(namespace: string, laneKey: string): LaneGenerationToken {
    const normalizedNamespace = String(namespace ?? "").trim();
    const normalizedLaneKey = String(laneKey ?? "").trim();
    return {
      namespace: normalizedNamespace,
      laneKey: normalizedLaneKey,
      generation: this.getGeneration(normalizedNamespace, normalizedLaneKey),
    };
  }
}
