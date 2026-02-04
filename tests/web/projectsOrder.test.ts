import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../src/state/database.js";
import { ensureWebAuthTables } from "../../src/web/auth/schema.js";
import { ensureWebProjectTables } from "../../src/web/projects/schema.js";
import { listWebProjects, upsertWebProject } from "../../src/web/projects/store.js";
import { handleProjectRoutes } from "../../src/web/server/api/routes/projects.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createReq(method: string, body?: unknown): FakeReq {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) {
        yield payload;
      }
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

function parseJson(body: string): unknown {
  return body ? (JSON.parse(body) as unknown) : null;
}

describe("web/projects ordering", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-projects-order-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("backfills sort_order to preserve legacy updated_at ordering", () => {
    const db = getStateDatabase();
    ensureWebAuthTables(db);

    // Simulate a legacy table without sort_order.
    db.exec(`
      CREATE TABLE web_projects (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        display_name TEXT NOT NULL,
        chat_session_id TEXT NOT NULL DEFAULT 'main',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, project_id),
        UNIQUE(user_id, workspace_root),
        FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_web_projects_user_updated
        ON web_projects(user_id, updated_at DESC, created_at DESC);
    `);

    db.prepare(
      `INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("u", "u", "x", 1, 1);

    const insert = db.prepare(
      `
        INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insert.run("u", "p1", "/a", "A", "main", 10, 10);
    insert.run("u", "p2", "/b", "B", "main", 20, 30);
    insert.run("u", "p3", "/c", "C", "main", 30, 20);

    ensureWebProjectTables(db);

    const cols = db.prepare(`PRAGMA table_info('web_projects')`).all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "sort_order"));

    const rows = db
      .prepare(`SELECT project_id AS id, sort_order AS sortOrder FROM web_projects WHERE user_id = ? ORDER BY sort_order ASC`)
      .all("u") as Array<{ id: string; sortOrder: number }>;
    assert.deepEqual(
      rows.map((r) => r.id),
      ["p2", "p3", "p1"],
    );

    const listed = listWebProjects(db, "u");
    assert.deepEqual(
      listed.map((p) => p.id),
      ["p2", "p3", "p1"],
    );
  });

  it("POST /api/projects/reorder persists custom ordering", async () => {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);

    db.prepare(
      `INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("u", "u", "x", 1, 1);

    upsertWebProject(db, { userId: "u", projectId: "p1", workspaceRoot: "/a", name: "A" }, 10);
    upsertWebProject(db, { userId: "u", projectId: "p2", workspaceRoot: "/b", name: "B" }, 20);
    upsertWebProject(db, { userId: "u", projectId: "p3", workspaceRoot: "/c", name: "C" }, 30);

    const reorderReq = createReq("POST", { ids: ["p3", "p1", "p2"] });
    const reorderRes = createRes();
    const reorderHandled = await handleProjectRoutes(
      {
        req: reorderReq as any,
        res: reorderRes as any,
        url: new URL("http://localhost/api/projects/reorder"),
        pathname: "/api/projects/reorder",
        auth: { userId: "u", username: "u" },
      } as any,
      { allowedDirs: [] },
    );
    assert.equal(reorderHandled, true);
    assert.equal(reorderRes.statusCode, 200);
    assert.deepEqual(parseJson(reorderRes.body), { success: true });

    const getReq = createReq("GET");
    const getRes = createRes();
    const getHandled = await handleProjectRoutes(
      {
        req: getReq as any,
        res: getRes as any,
        url: new URL("http://localhost/api/projects"),
        pathname: "/api/projects",
        auth: { userId: "u", username: "u" },
      } as any,
      { allowedDirs: [] },
    );
    assert.equal(getHandled, true);
    assert.equal(getRes.statusCode, 200);
    const payload = parseJson(getRes.body) as { projects: Array<{ id: string }>; activeProjectId: string | null };
    assert.deepEqual(
      payload.projects.map((p) => p.id),
      ["p3", "p1", "p2"],
    );
  });
});

