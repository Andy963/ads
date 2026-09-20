import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { handleModelRoutes, resetUpstreamModelsCache } from "../../server/web/server/api/routes/models.js";

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
      this.headers = { ...this.headers, ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])) };
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
  let db: DatabaseType;
  let modelStore: ReturnType<typeof createGlobalModelConfigStore>;
  let upstreamStore: ReturnType<typeof createUpstreamCredentialStore>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-model-config-routes-"));
    db = new DatabaseConstructor(path.join(tmpDir, "state.db"));
    modelStore = createGlobalModelConfigStore(db);
    upstreamStore = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    resetUpstreamModelsCache();
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("POST creates trimmed model configs and PATCH preserves unspecified fields", async () => {
    const createResPayload = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "  claude-sonnet-4-6  ",
          displayName: "  Claude Sonnet  ",
          provider: "  anthropic  ",
          isEnabled: false,
          configJson: { temperature: 0.2 },
        }) as any,
        res: createResPayload as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );
    assert.equal(createResPayload.statusCode, 200);
    const created = parseJson<{
      id: string;
      modelId: string;
      displayName: string;
      provider: string;
      isEnabled: boolean;
      isDefault: boolean;
      configJson: Record<string, unknown> | null;
      updatedAt?: number | null;
    }>(createResPayload.body);
    assert.match(created.id, /^model-[0-9a-f-]+$/);
    assert.notEqual(created.id, created.modelId);
    assert.equal(created.modelId, "claude-sonnet-4-6");
    assert.equal(created.displayName, "Claude Sonnet");
    assert.equal(created.provider, "anthropic");
    assert.equal(created.isEnabled, false);
    assert.equal(created.isDefault, false);
    assert.deepEqual(created.configJson, { temperature: 0.2 });
    assert.equal(typeof created.updatedAt, "number");

    const patchResPayload = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("PATCH", { displayName: "  Claude Sonnet 4.1  ", isDefault: true }) as any,
        res: patchResPayload as any,
        url: new URL(`http://localhost/api/model-configs/${created.id}`),
        pathname: `/api/model-configs/${created.id}`,
      } as any, { modelStore }),
      true,
    );
    assert.equal(patchResPayload.statusCode, 200);
    const updated = parseJson<{
      id: string;
      modelId: string;
      displayName: string;
      provider: string;
      isEnabled: boolean;
      isDefault: boolean;
      configJson: Record<string, unknown> | null;
      updatedAt?: number | null;
    }>(patchResPayload.body);
    assert.equal(updated.id, created.id);
    assert.equal(updated.modelId, "claude-sonnet-4-6");
    assert.equal(updated.displayName, "Claude Sonnet 4.1");
    assert.equal(updated.provider, "anthropic");
    assert.equal(updated.isEnabled, false);
    assert.equal(updated.isDefault, true);
    assert.deepEqual(updated.configJson, { temperature: 0.2 });
    assert.equal(typeof updated.updatedAt, "number");
  });

  it("preserves the full reasoning effort spectrum and strips only invalid values on write", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "extended-reasoning-model",
          provider: "openai",
          configJson: {
            reasoningEfforts: ["low", "max", "high", "ultra", "xhigh", "bogus"],
            defaultReasoningEffort: "xhigh",
            reasoningEffort: "max",
          },
        }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );

    assert.equal(res.statusCode, 200);
    const created = parseJson<{ configJson: Record<string, unknown> }>(res.body);
    assert.deepEqual(created.configJson, {
      reasoningEfforts: ["low", "max", "high", "ultra", "xhigh"],
      defaultReasoningEffort: "xhigh",
      reasoningEffort: "max",
    });
  });

  it("falls back to high when no valid reasoning effort remains after sanitizing", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "invalid-reasoning-model",
          provider: "openai",
          configJson: {
            reasoningEfforts: ["bogus", "extreme"],
            defaultReasoningEffort: "xhigh",
            reasoningEffort: "bogus",
          },
        }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );

    assert.equal(res.statusCode, 200);
    const created = parseJson<{ configJson: Record<string, unknown> }>(res.body);
    assert.deepEqual(created.configJson, {
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    });
  });

  it("rejects API keys embedded in model config JSON", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "unsafe-model",
          provider: "openai",
          configJson: { credentialProfile: "default", transport: { apiKey: "must-not-persist" } },
        }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /invalid payload/i);
    assert.equal(modelStore.getModelConfigByAgentModelId("unsafe-model"), null);
  });

  it("PATCH can update the agent model id without changing the row id", async () => {
    modelStore.upsertModelConfig({
      id: "old-model",
      modelId: "old-agent-model",
      displayName: "Old Model",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: null,
    });

    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("PATCH", { modelId: " new-agent-model ", displayName: "New Model" }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs/old-model"),
        pathname: "/api/model-configs/old-model",
      } as any, { modelStore }),
      true,
    );

    assert.equal(res.statusCode, 200);
    const updated = parseJson<{ id: string; modelId: string; displayName: string }>(res.body);
    assert.equal(updated.id, "old-model");
    assert.equal(updated.modelId, "new-agent-model");
    assert.equal(updated.displayName, "New Model");
    assert.equal(modelStore.getModelConfig("old-model")?.modelId, "new-agent-model");
  });

  it("rejects reserved auto agent model id", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: " auto ",
          displayName: "Auto",
          provider: "internal",
        }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson<{ error: string }>(res.body), { error: "Invalid model id" });
  });

  it("defaults blank-only display names to model id", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "model-2",
          displayName: "   ",
          provider: "anthropic",
        }) as any,
        res: res as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );
    assert.equal(res.statusCode, 200);
    const created = parseJson<{ id: string; modelId: string; displayName: string }>(res.body);
    assert.match(created.id, /^model-[0-9a-f-]+$/);
    assert.equal(created.modelId, "model-2");
    assert.equal(created.displayName, "model-2");
  });

  it("POST updates an existing config when the agent model id already exists", async () => {
    const first = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "gpt-5.2",
          displayName: "GPT 5.2",
          provider: "openai",
        }) as any,
        res: first as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );
    const created = parseJson<{ id: string }>(first.body);

    const second = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("POST", {
          modelId: "gpt-5.2",
          displayName: "GPT 5.2 Updated",
          provider: "openai",
        }) as any,
        res: second as any,
        url: new URL("http://localhost/api/model-configs"),
        pathname: "/api/model-configs",
      } as any, { modelStore }),
      true,
    );
    const updated = parseJson<{ id: string; displayName: string }>(second.body);
    assert.equal(updated.id, created.id);
    assert.equal(updated.displayName, "GPT 5.2 Updated");
    assert.equal(modelStore.listModelConfigs().length, 1);
  });

  it("GET /api/models returns enabled configs from the global state database", async () => {
    modelStore.upsertModelConfig({
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      provider: "openai",
      isEnabled: true,
      isDefault: true,
      configJson: null,
    });
    modelStore.upsertModelConfig({
      id: "old-model",
      displayName: "Old Model",
      provider: "openai",
      isEnabled: false,
      isDefault: false,
      configJson: null,
    });

    const res = createRes();
    assert.equal(
      await handleModelRoutes({
        req: createReq("GET") as any,
        res: res as any,
        url: new URL("http://localhost/api/models"),
        pathname: "/api/models",
      } as any, {
        modelStore,
      }),
      true,
    );

    assert.equal(res.statusCode, 200);
    const models = parseJson<Array<{ id: string }>>(res.body);
    assert.deepEqual(
      models.map((model) => model.id),
      ["gpt-5.4"],
    );
  });

  it("keeps one default model across the unified Codex scope", () => {
    modelStore.upsertModelConfig({
      id: "codex-default",
      modelId: "gpt-codex",
      displayName: "Codex Default",
      provider: "openai",
      isEnabled: true,
      isDefault: true,
      configJson: { allowedAgents: ["codex"] },
    });
    modelStore.upsertModelConfig({
      id: "claude-default",
      modelId: "claude-default",
      displayName: "Claude Default",
      provider: "anthropic",
      isEnabled: true,
      isDefault: true,
      configJson: { allowedAgents: ["claude"] },
    });

    assert.equal(modelStore.getModelConfig("codex-default")?.isDefault, false);
    assert.equal(modelStore.getModelConfig("claude-default")?.isDefault, true);

    modelStore.upsertModelConfig({
      id: "codex-next",
      modelId: "gpt-codex-next",
      displayName: "Codex Next",
      provider: "openai",
      isEnabled: true,
      isDefault: true,
      configJson: { allowedAgents: ["codex"] },
    });

    assert.equal(modelStore.getModelConfig("codex-default")?.isDefault, false);
    assert.equal(modelStore.getModelConfig("codex-next")?.isDefault, true);
    assert.equal(modelStore.getModelConfig("claude-default")?.isDefault, false);
  });

  it("GET /api/models/upstream returns sorted unique model ids from the provider catalog", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: unknown, init: { headers: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5.6-sol" },
            { id: "" },
            { id: null },
            { id: "gemini-3.7-flash" },
            { id: "gpt-5.6-sol" },
            "malformed-entry",
            { id: {} },
            { id: 42 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("GET") as any,
          res: res as any,
          url: new URL("http://localhost/api/models/upstream"),
          auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream",
        } as any,
        {
          modelStore, upstreamStore,
          resolveConfig: () => ({ baseUrl: "https://provider.test/v1/", apiKey: "sk-test", authMode: "apiKey" }),
          fetchImpl,
        },
      ),
      true,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson<{ ok: boolean; models: string[] }>(res.body), {
      ok: true,
      models: ["gemini-3.7-flash", "gpt-5.6-sol"],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://provider.test/v1/models");
    assert.equal(calls[0].headers.Authorization, "Bearer sk-test");
  });

  it("prefills metadata and reuses a saved key only for its canonical endpoint", async () => {
    const calls: Array<{ url: string; key: string }> = [];
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, "error");
      calls.push({ url: String(url), key: new Headers(init.headers).get("Authorization")! });
      return new Response(JSON.stringify({ data: [{ id: "selected-model" }] }));
    }) as typeof fetch;
    const deps = { modelStore, upstreamStore, fetchImpl,
      resolveConfig: () => ({ authMode: "apiKey" as const }) };
    const call = async (method: string, pathname: string, body?: unknown, userId = "alice") => {
      const res = createRes();
      await handleModelRoutes({ req: createReq(method, body) as any, res: res as any,
        url: new URL(pathname, "http://localhost"), pathname, auth: { userId, username: userId } }, deps);
      return res;
    };
    const saved = await call("POST", "/api/models/upstream", { baseUrl: "provider.test", apiKey: "custom-test-key", provider: "custom" });
    assert.equal(JSON.parse(saved.body).ok, true);
    const config = await call("GET", "/api/models/upstream/config");
    assert.deepEqual(JSON.parse(config.body), { baseUrl: "https://provider.test/v1", provider: "custom", hasApiKey: true, source: "saved" });
    assert.equal(config.headers["cache-control"], "no-store");
    assert.ok(!config.body.includes("custom-test-key"));
    resetUpstreamModelsCache();
    const reused = await call("POST", "/api/models/upstream", { baseUrl: "https://provider.test/v1/responses" });
    assert.equal(JSON.parse(reused.body).ok, true);
    assert.deepEqual(calls, [
      { url: "https://provider.test/v1/models", key: "Bearer custom-test-key" },
      { url: "https://provider.test/v1/models", key: "Bearer custom-test-key" },
    ]);
    const rejected = await call("POST", "/api/models/upstream", { baseUrl: "https://different.test" });
    assert.equal(JSON.parse(rejected.body).ok, false);
    assert.match(JSON.parse(rejected.body).error, /bound to their endpoint/);
    assert.equal(calls.length, 2);
    const isolated = await call("GET", "/api/models/upstream/config", undefined, "bob");
    assert.equal(JSON.parse(isolated.body).hasApiKey, false);
    assert.equal(JSON.parse((await call("POST", "/api/models/upstream", {}, "bob")).body).ok, false);
    assert.equal(calls.length, 2);
  });

  it("never combines a new endpoint with the default server key or replaces saved credentials on failure", async () => {
    let fetchCount = 0;
    const deps = { modelStore, upstreamStore,
      resolveConfig: () => ({ baseUrl: "https://default.test/v1", apiKey: "default-test-key", authMode: "apiKey" as const }),
      fetchImpl: (async () => { fetchCount += 1; return new Response("unavailable", { status: 503 }); }) as typeof fetch };
    const call = async (body: unknown) => {
      const res = createRes();
      await handleModelRoutes({ req: createReq("POST", body) as any, res: res as any,
        url: new URL("http://localhost/api/models/upstream"), pathname: "/api/models/upstream",
        auth: { userId: "alice", username: "alice" } }, deps);
      return JSON.parse(res.body);
    };
    assert.equal((await call({ baseUrl: "https://different.test" })).ok, false);
    assert.equal(fetchCount, 0);
    upstreamStore.save("alice", { baseUrl: "https://saved.test/v1", apiKey: "saved-test-key", provider: "saved" });
    assert.equal((await call({ baseUrl: "https://new.test", apiKey: "new-test-key" })).ok, false);
    assert.equal(upstreamStore.getCredentials("alice")?.apiKey, "saved-test-key");
    assert.equal(fetchCount, 1);
  });

  it("does not echo credentials even if an upstream transport error includes them", async () => {
    const res = createRes();
    await handleModelRoutes({ req: createReq("POST", { baseUrl: "https://provider.test", apiKey: "test-sensitive-key" }) as any,
      res: res as any, url: new URL("http://localhost/api/models/upstream"), pathname: "/api/models/upstream",
      auth: { userId: "alice", username: "alice" } }, { modelStore, upstreamStore,
      fetchImpl: (async () => { throw new Error("Failed with test-sensitive-key"); }) as typeof fetch });
    assert.equal(JSON.parse(res.body).ok, false);
    assert.ok(!res.body.includes("test-sensitive-key"));
    assert.equal(upstreamStore.getMetadata("alice"), null);
  });

  it("POST /api/models/upstream/discover persists custom provider credentials without reading defaults", async () => {
    let resolvedDefaults = false;
    const fetchImpl = (async (url: unknown, init: { headers: Record<string, string> }) => {
      assert.equal(String(url), "https://custom-provider.test/v1/models");
      assert.equal(init.headers.Authorization, "Bearer custom-key");
      return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = createRes();

    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("POST", { baseUrl: "https://custom-provider.test/v1", apiKey: "custom-key" }) as any,
          res: res as any,
          url: new URL("http://localhost/api/models/upstream/discover"),
          auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream/discover",
        } as any,
        {
          modelStore, upstreamStore,
          resolveConfig: (overrides) => {
            resolvedDefaults = true;
            return {
              baseUrl: overrides?.baseUrl,
              apiKey: overrides?.apiKey,
              authMode: "apiKey",
            };
          },
          fetchImpl,
        },
      ),
      true,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson<{ ok: boolean; models: string[] }>(res.body), {
      ok: true,
      models: ["custom-model"],
    });
    assert.equal(resolvedDefaults, false);
    assert.equal(upstreamStore.getCredentials("user-234")?.apiKey, "custom-key");
    assert.ok(!JSON.stringify(db.prepare("SELECT value FROM kv_state").all()).includes("custom-key"));
  });

  it("GET /api/models/upstream serves the cached catalog within the TTL", async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = {
      modelStore, upstreamStore,
      resolveConfig: () => ({ baseUrl: "https://provider.test/v1", apiKey: "sk-test", authMode: "apiKey" as const }),
      fetchImpl,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = createRes();
      assert.equal(
        await handleModelRoutes(
          {
            req: createReq("GET") as any,
            res: res as any,
            url: new URL("http://localhost/api/models/upstream"),
            auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream",
          } as any,
          deps,
        ),
        true,
      );
      assert.deepEqual(parseJson<{ ok: boolean; models: string[] }>(res.body), {
        ok: true,
        models: ["gpt-5.6-sol"],
      });
    }
    assert.equal(fetchCount, 1);
  });

  it("GET /api/models/upstream degrades gracefully when credentials are missing", async () => {
    const res = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("GET") as any,
          res: res as any,
          url: new URL("http://localhost/api/models/upstream"),
          auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream",
        } as any,
        {
          modelStore, upstreamStore,
          resolveConfig: () => {
            throw new Error("Codex credentials not found");
          },
        },
      ),
      true,
    );

    assert.equal(res.statusCode, 200);
    const payload = parseJson<{ ok: boolean; models: string[]; error?: string }>(res.body);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.models, []);
    assert.match(payload.error ?? "", /credentials not found/);
  });

  it("GET /api/models/upstream degrades gracefully on network and HTTP failures", async () => {
    const resolveConfig = () => ({ baseUrl: "https://provider.test/v1", apiKey: "sk-test", authMode: "apiKey" as const });

    const networkFailure = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("GET") as any,
          res: networkFailure as any,
          url: new URL("http://localhost/api/models/upstream"),
          auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream",
        } as any,
        {
          modelStore, upstreamStore,
          resolveConfig,
          fetchImpl: (async () => {
            throw new Error("connect ETIMEDOUT");
          }) as unknown as typeof fetch,
        },
      ),
      true,
    );
    const networkPayload = parseJson<{ ok: boolean; models: string[]; error?: string }>(networkFailure.body);
    assert.equal(networkPayload.ok, false);
    assert.deepEqual(networkPayload.models, []);
    assert.match(networkPayload.error ?? "", /ETIMEDOUT/);

    const httpFailure = createRes();
    assert.equal(
      await handleModelRoutes(
        {
          req: createReq("GET") as any,
          res: httpFailure as any,
          url: new URL("http://localhost/api/models/upstream"),
          auth: { userId: "user-234", username: "tester" },
          pathname: "/api/models/upstream",
        } as any,
        {
          modelStore, upstreamStore,
          resolveConfig,
          fetchImpl: (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch,
        },
      ),
      true,
    );
    const httpPayload = parseJson<{ ok: boolean; models: string[]; error?: string }>(httpFailure.body);
    assert.equal(httpPayload.ok, false);
    assert.deepEqual(httpPayload.models, []);
    assert.match(httpPayload.error ?? "", /HTTP 503/);
  });
});
