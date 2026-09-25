import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getStateDatabase,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";
import { handleRoleProfileRoutes } from "../../server/web/server/api/routes/roleProfiles.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createReq(method: string): FakeReq {
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      // no body
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function routeContext(req: FakeReq, res: FakeRes, pathname: string): never {
  return {
    req,
    res,
    url: new URL(`http://localhost${pathname}`),
    pathname,
    auth: { userId: "1", username: "test" },
  } as never;
}

describe("web/role-profile legacy role resolution", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-role-profile-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("resolves a legacy worker profile to the developer role", async () => {
    // The stored `worker` profile describes the implementation role, so it maps
    // to `developer` -- not to the `actions` lane. Getting this backwards would
    // silently return the wrong settings history.
    getStateDatabase();
    const res = createRes();
    const handled = await handleRoleProfileRoutes(
      routeContext(createReq("GET"), res, "/api/role-profiles/worker/history"),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200, "legacy worker profile should resolve");
  });

  it("still resolves legacy advisor and canonical ids", async () => {
    getStateDatabase();
    for (const role of ["advisor", "acopilot", "developer", "reviewer"]) {
      const res = createRes();
      await handleRoleProfileRoutes(
        routeContext(createReq("GET"), res, `/api/role-profiles/${role}/history`),
      );
      assert.equal(res.statusCode, 200, `${role} should resolve`);
    }
  });

  it("rejects a role that is neither canonical nor a legacy alias", async () => {
    getStateDatabase();
    for (const role of ["actions", "telegram", "planner", "actions2"]) {
      const res = createRes();
      await handleRoleProfileRoutes(
        routeContext(createReq("GET"), res, `/api/role-profiles/${role}/history`),
      );
      // `actions` is a lane, not a stored role profile: the role vocabulary is
      // deliberately disjoint from the lane vocabulary.
      assert.equal(res.statusCode, 400, `${role} must be rejected as a role`);
    }
  });

  it("does not match an empty role segment", async () => {
    // An empty path segment never reaches the handler; it is not a 400 from
    // this route but simply a URL this route does not own.
    getStateDatabase();
    const res = createRes();
    const handled = await handleRoleProfileRoutes(
      routeContext(createReq("GET"), res, "/api/role-profiles//history"),
    );
    assert.equal(handled, false);
  });
});
