import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createReviewerModelStore } from "../../server/state/reviewerModelStore.js";
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
  let db: DatabaseType;
  let modelStore: ReturnType<typeof createGlobalModelConfigStore>;
  let reviewerModelStore: ReturnType<typeof createReviewerModelStore>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-model-config-routes-"));
    db = new DatabaseConstructor(path.join(tmpDir, "state.db"));
    modelStore = createGlobalModelConfigStore(db);
    reviewerModelStore = createReviewerModelStore(db, modelStore);
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

  it("reads and updates the explicit reviewer model without accepting disabled or auto models", async () => {
    modelStore.upsertModelConfig({
      id: "worker-model",
      modelId: "gpt-5.6-luna",
      displayName: "Worker",
      provider: "openai",
      isEnabled: true,
      isDefault: true,
      configJson: { allowedAgents: ["codex"] },
    });
    modelStore.upsertModelConfig({
      id: "reviewer-model",
      modelId: "gpt-5.6-sol",
      displayName: "Reviewer",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: { allowedAgents: ["codex"] },
    });

    const getRes = createRes();
    await handleModelRoutes({
      req: createReq("GET") as any,
      res: getRes as any,
      url: new URL("http://localhost/api/reviewer-model"),
      pathname: "/api/reviewer-model",
    } as any, { modelStore, reviewerModelStore });
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(parseJson(getRes.body), { modelConfigId: null, modelId: null, model: null });

    const patchRes = createRes();
    await handleModelRoutes({
      req: createReq("PATCH", { modelConfigId: "reviewer-model" }) as any,
      res: patchRes as any,
      url: new URL("http://localhost/api/reviewer-model"),
      pathname: "/api/reviewer-model",
    } as any, { modelStore, reviewerModelStore });
    assert.equal(patchRes.statusCode, 200);
    assert.deepEqual(parseJson(patchRes.body), {
      modelConfigId: "reviewer-model",
      modelId: "gpt-5.6-sol",
      model: {
        id: "reviewer-model",
        modelId: "gpt-5.6-sol",
        displayName: "Reviewer",
        provider: "openai",
        isEnabled: true,
        isDefault: false,
        configJson: { allowedAgents: ["codex"] },
        updatedAt: parseJson<{ model: { updatedAt: number } }>(patchRes.body).model.updatedAt,
      },
    });

    modelStore.upsertModelConfig({
      id: "disabled-model",
      modelId: "gpt-5.6-disabled",
      displayName: "Disabled",
      provider: "openai",
      isEnabled: false,
      isDefault: false,
      configJson: null,
    });
    const invalidRes = createRes();
    await handleModelRoutes({
      req: createReq("PATCH", { modelConfigId: "disabled-model" }) as any,
      res: invalidRes as any,
      url: new URL("http://localhost/api/reviewer-model"),
      pathname: "/api/reviewer-model",
    } as any, { modelStore, reviewerModelStore });
    assert.equal(invalidRes.statusCode, 400);

    const aliasRes = createRes();
    await handleModelRoutes({
      req: createReq("PATCH", { modelId: "gpt-5.6-sol" }) as any,
      res: aliasRes as any,
      url: new URL("http://localhost/api/reviewer-model"),
      pathname: "/api/reviewer-model",
    } as any, { modelStore, reviewerModelStore });
    assert.equal(aliasRes.statusCode, 200);
    assert.equal(parseJson<{ modelConfigId: string }>(aliasRes.body).modelConfigId, "reviewer-model");
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

  it("keeps defaults independent for different agent scopes", () => {
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

    assert.equal(modelStore.getModelConfig("codex-default")?.isDefault, true);
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
    assert.equal(modelStore.getModelConfig("claude-default")?.isDefault, true);
  });
});
