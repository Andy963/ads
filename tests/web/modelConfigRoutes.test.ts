import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import { handleModelRoutes } from "../../server/web/server/api/routes/models.js";

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
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
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

describe("web/model-config routes", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-model-config-routes-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    taskStore = new TaskStore();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("POST creates trimmed model configs and PATCH preserves unspecified fields", async () => {
    const deps = {
      resolveTaskContext() {
        return { taskStore };
      },
    };

    const createResPayload = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("POST", {
            id: "  model-1  ",
            displayName: "  Claude Sonnet  ",
            provider: "  anthropic  ",
            isEnabled: false,
            configJson: { temperature: 0.2 },
          }) as any,
          res: createResPayload as any,
          url: new URL("http://localhost/api/model-configs"),
          pathname: "/api/model-configs",
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(createResPayload.statusCode, 200);
    const created = parseJson<{
      id: string;
      displayName: string;
      provider: string;
      isEnabled: boolean;
      isDefault: boolean;
      configJson: Record<string, unknown> | null;
      updatedAt?: number | null;
    }>(createResPayload.body);
    assert.equal(created.id, "model-1");
    assert.equal(created.displayName, "Claude Sonnet");
    assert.equal(created.provider, "anthropic");
    assert.equal(created.isEnabled, false);
    assert.equal(created.isDefault, false);
    assert.deepEqual(created.configJson, { temperature: 0.2 });
    assert.equal(typeof created.updatedAt, "number");

    const patchResPayload = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("PATCH", { displayName: "  Claude Sonnet 4.1  ", isDefault: true }) as any,
          res: patchResPayload as any,
          url: new URL("http://localhost/api/model-configs/model-1"),
          pathname: "/api/model-configs/model-1",
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(patchResPayload.statusCode, 200);
    const updated = parseJson<{
      id: string;
      displayName: string;
      provider: string;
      isEnabled: boolean;
      isDefault: boolean;
      configJson: Record<string, unknown> | null;
      updatedAt?: number | null;
    }>(patchResPayload.body);
    assert.equal(updated.id, "model-1");
    assert.equal(updated.displayName, "Claude Sonnet 4.1");
    assert.equal(updated.provider, "anthropic");
    assert.equal(updated.isEnabled, false);
    assert.equal(updated.isDefault, true);
    assert.deepEqual(updated.configJson, { temperature: 0.2 });
    assert.equal(typeof updated.updatedAt, "number");
  });

  it("rejects reserved auto model id", async () => {
    const deps = {
      resolveTaskContext() {
        return { taskStore };
      },
    };
    const res = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("POST", {
            id: " auto ",
            displayName: "Auto",
            provider: "internal",
          }) as any,
          res: res as any,
          url: new URL("http://localhost/api/model-configs"),
          pathname: "/api/model-configs",
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson<{ error: string }>(res.body), { error: "Invalid model id" });
  });

  it("rejects blank-only display names after trim", async () => {
    const deps = {
      resolveTaskContext() {
        return { taskStore };
      },
    };
    const res = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("POST", {
            id: "model-2",
            displayName: "   ",
            provider: "anthropic",
          }) as any,
          res: res as any,
          url: new URL("http://localhost/api/model-configs"),
          pathname: "/api/model-configs",
        } as any,
        deps as any,
      ),
      true,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson<{ error: string }>(res.body), { error: "Invalid payload" });
  });
});
