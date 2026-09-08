import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createLanePromptStore } from "../../server/state/lanePromptStore.js";
import { handleLanePromptRoutes } from "../../server/web/server/api/routes/lanePrompts.js";

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

function createReq(method: string, body?: unknown): FakeReq {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload;
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

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

function routeContext(req: FakeReq, res: FakeRes, pathname: string): any {
  return {
    req,
    res,
    url: new URL(`http://localhost${pathname}`),
    pathname,
    auth: { userId: "1", username: "test" },
  };
}

describe("web/lane-prompt routes", () => {
  let db: DatabaseType;
  let store: ReturnType<typeof createLanePromptStore>;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    store = createLanePromptStore(db);
  });

  afterEach(() => db.close());

  it("lists, updates, and resets lane prompts", async () => {
    const listRes = createRes();
    assert.equal(await handleLanePromptRoutes(routeContext(createReq("GET"), listRes, "/api/lane-prompts"), { lanePromptStore: store }), true);
    assert.equal(listRes.statusCode, 200);
    assert.equal(parseJson<unknown[]>(listRes.body).length, 2);

    const updateRes = createRes();
    await handleLanePromptRoutes(
      routeContext(createReq("PUT", { prompt: "Custom worker prompt" }), updateRes, "/api/lane-prompts/worker"),
      { lanePromptStore: store },
    );
    assert.equal(updateRes.statusCode, 200);
    assert.equal(parseJson<{ current: { prompt: string; version: number } }>(updateRes.body).current.prompt, "Custom worker prompt");

    const resetRes = createRes();
    await handleLanePromptRoutes(routeContext(createReq("POST"), resetRes, "/api/lane-prompts/worker/reset"), { lanePromptStore: store });
    assert.equal(resetRes.statusCode, 200);
    const reset = parseJson<{ current: { version: number }; base: { version: number } }>(resetRes.body);
    assert.equal(reset.current.version, reset.base.version);
  });

  it("rejects unknown lanes and invalid payloads", async () => {
    const laneRes = createRes();
    await handleLanePromptRoutes(routeContext(createReq("GET"), laneRes, "/api/lane-prompts/telegram"), { lanePromptStore: store });
    assert.equal(laneRes.statusCode, 400);

    const payloadRes = createRes();
    await handleLanePromptRoutes(routeContext(createReq("PUT", { prompt: "" }), payloadRes, "/api/lane-prompts/advisor"), { lanePromptStore: store });
    assert.equal(payloadRes.statusCode, 400);
  });
});
