import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../src/state/database.js";
import { ensureWebAuthTables } from "../../src/web/auth/schema.js";

import { handlePromptRoutes } from "../../src/web/server/api/routes/prompts.js";

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

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

describe("web/prompts CRUD", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompts-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    db.prepare(`INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      "u",
      "u",
      "x",
      1,
      1,
    );
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

  it("supports list/create/update/delete", async () => {
    const auth = { userId: "u", username: "u" };

    const listEmptyReq = createReq("GET");
    const listEmptyRes = createRes();
    assert.equal(
      await handlePromptRoutes(
        {
          req: listEmptyReq as any,
          res: listEmptyRes as any,
          url: new URL("http://localhost/api/prompts"),
          pathname: "/api/prompts",
          auth,
        } as any,
        {},
      ),
      true,
    );
    assert.equal(listEmptyRes.statusCode, 200);
    assert.deepEqual(parseJson<{ prompts: unknown[] }>(listEmptyRes.body).prompts, []);

    const createReq1 = createReq("POST", { name: "p1", content: "hello" });
    const createRes1 = createRes();
    assert.equal(
      await handlePromptRoutes(
        {
          req: createReq1 as any,
          res: createRes1 as any,
          url: new URL("http://localhost/api/prompts"),
          pathname: "/api/prompts",
          auth,
        } as any,
        {},
      ),
      true,
    );
    assert.equal(createRes1.statusCode, 201);
    const created = parseJson<{ prompt: { id: string; name: string; content: string } }>(createRes1.body).prompt;
    assert.equal(created.name, "p1");
    assert.equal(created.content, "hello");
    assert.ok(created.id);

    const updateReq1 = createReq("PATCH", { name: "p1-renamed", content: "world" });
    const updateRes1 = createRes();
    assert.equal(
      await handlePromptRoutes(
        {
          req: updateReq1 as any,
          res: updateRes1 as any,
          url: new URL(`http://localhost/api/prompts/${created.id}`),
          pathname: `/api/prompts/${created.id}`,
          auth,
        } as any,
        {},
      ),
      true,
    );
    assert.equal(updateRes1.statusCode, 200);
    const updated = parseJson<{ prompt: { id: string; name: string; content: string } }>(updateRes1.body).prompt;
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "p1-renamed");
    assert.equal(updated.content, "world");

    const listReq = createReq("GET");
    const listRes = createRes();
    assert.equal(
      await handlePromptRoutes(
        { req: listReq as any, res: listRes as any, url: new URL("http://localhost/api/prompts"), pathname: "/api/prompts", auth } as any,
        {},
      ),
      true,
    );
    assert.equal(listRes.statusCode, 200);
    const listed = parseJson<{ prompts: Array<{ id: string; name: string; content: string }> }>(listRes.body).prompts;
    assert.deepEqual(listed.map((p) => ({ id: p.id, name: p.name, content: p.content })), [
      { id: created.id, name: "p1-renamed", content: "world" },
    ]);

    const delReq = createReq("DELETE");
    const delRes = createRes();
    assert.equal(
      await handlePromptRoutes(
        {
          req: delReq as any,
          res: delRes as any,
          url: new URL(`http://localhost/api/prompts/${created.id}`),
          pathname: `/api/prompts/${created.id}`,
          auth,
        } as any,
        {},
      ),
      true,
    );
    assert.equal(delRes.statusCode, 200);
    assert.deepEqual(parseJson<{ success: boolean }>(delRes.body), { success: true });
  });
});

