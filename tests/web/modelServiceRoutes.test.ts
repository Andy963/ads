import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";
import Database from "better-sqlite3";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { handleModelRoutes } from "../../server/web/server/api/routes/models.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { ensureRoleProfiles, getDefaultRoleProfile, saveRoleProfile } from "../../server/state/roleProfileStore.js";

it("round-trips provider catalogs, same-name models and service defaults through HTTP", async () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const modelStore = createGlobalModelConfigStore(db);
  const providerStore = createModelProviderStore(db);
  const upstreamStore = createUpstreamCredentialStore(db, { pepper: "test-pepper" });
  const requested: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    void handleModelRoutes({ req, res, url, pathname: url.pathname, auth: { userId: "owner", username: "owner" } } as any, {
      modelStore, providerStore, upstreamStore,
      fetchImpl: (async (url: string | URL | Request) => {
        requested.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: "same-name" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  try {
    const first = await request("/api/model-providers", "POST", { name: "One", baseUrl: "https://one.invalid/v1", apiKey: "key-one" });
    const second = await request("/api/model-providers", "POST", { name: "Two", baseUrl: "https://two.invalid/v1", apiKey: "key-two" });
    assert.equal(first.status, 200);
    assert.doesNotMatch(JSON.stringify(first.body), /key-one/);
    for (const provider of [first.body, second.body]) assert.equal((await request("/api/model-providers/" + provider.id + "/models/sync", "POST", {})).status, 200);
    assert.deepEqual(requested.sort(), ["https://one.invalid/v1/models", "https://two.invalid/v1/models"]);
    const catalog = (await request("/api/model-configs")).body;
    assert.equal(catalog.length, 2);
    assert.notEqual(catalog[0].id, catalog[1].id);
    assert.deepEqual((await request("/api/models")).body, []);
    const one = catalog.find((model: { providerId: string }) => model.providerId === first.body.id);
    const two = catalog.find((model: { providerId: string }) => model.providerId === second.body.id);
    await request("/api/model-configs/" + one.id, "PATCH", { displayName: "Custom alias", configJson: { reasoningEfforts: ["medium", "high", "max"], defaultReasoningEffort: "max" } });
    await request("/api/model-providers/" + first.body.id + "/models/sync", "POST", {});
    assert.equal(modelStore.getModelConfig(one.id)?.displayName, "Custom alias");
    assert.equal(modelStore.getModelConfig(one.id)?.configJson?.defaultReasoningEffort, "max");
    assert.equal((await request("/api/model-services/transcription", "PUT", { modelIds: [one.id, two.id], defaultModelId: two.id })).status, 200);
    assert.equal((await request("/api/model-services/correction", "PUT", { modelIds: [one.id, two.id], defaultModelId: one.id })).status, 200);
    assert.equal((await request("/api/model-services/transcription", "PUT", { modelIds: [one.id], defaultModelId: two.id })).status, 400);
    assert.deepEqual((await request("/api/models")).body, []);
    await request("/api/model-services/conversation", "PUT", { modelIds: [one.id, two.id], defaultModelId: one.id });
    const enabled = (await request("/api/models")).body;
    assert.equal(enabled.length, 2);
    assert.equal(enabled.filter((model: { isDefault: boolean }) => model.isDefault).length, 1);
    assert.equal((await request("/api/model-configs/" + one.id, "DELETE")).status, 400);
    assert.equal((await request("/api/model-providers/" + first.body.id, "DELETE")).status, 409);
    assert.equal((await request("/api/model-providers/" + first.body.id, "PATCH", { name: "Renamed" })).status, 200);
    assert.equal(upstreamStore.getCredentials("owner", first.body.id)?.apiKey, "key-one");
    assert.equal((await request("/api/models")).body.find((model: { id: string }) => model.id === one.id).provider, "Renamed");
    assert.equal((await request("/api/model-providers/" + first.body.id, "PATCH", { baseUrl: "https://changed.invalid/v1" })).status, 400);

    const legacy = modelStore.upsertModelConfig({ id: "legacy-model", modelId: "legacy-upstream", displayName: "Old model", provider: "openai", isEnabled: true, isDefault: true });
    const services = createModelServiceStore(db);
    services.save("conversation", [legacy.id, one.id], legacy.id);
    ensureRoleProfiles(db);
    const role = getDefaultRoleProfile(db, "acopilot")!;
    saveRoleProfile(db, { ...role, model_id: legacy.id, is_enabled: true, is_default: true });
    assert.equal((await request("/api/model-configs/" + legacy.id, "DELETE")).status, 400);
    assert.equal((await request("/api/model-configs/" + legacy.id + "?removeReferences=true", "DELETE")).status, 200);
    assert.equal(modelStore.getModelConfig(legacy.id), null);
    assert.deepEqual(services.get("conversation"), { service: "conversation", modelIds: [one.id], defaultModelId: one.id });
    assert.equal(getDefaultRoleProfile(db, "acopilot")?.model_id, one.id);
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON model_configs BEGIN SELECT RAISE(ABORT, 'Deletion failed'); END");
    assert.throws(() => db.transaction(() => { services.removeModelReferences(one.id); modelStore.deleteModelConfig(one.id); })(), /Deletion failed/);
    assert.equal(services.get("conversation").defaultModelId, one.id);
    assert.equal(getDefaultRoleProfile(db, "acopilot")?.model_id, one.id);
    assert.ok(modelStore.getModelConfig(one.id));
    db.exec("DROP TRIGGER reject_delete");
    assert.equal((await request("/api/model-configs/" + one.id + "?removeReferences=true", "DELETE")).status, 200);
    assert.deepEqual(services.get("conversation"), { service: "conversation", modelIds: [], defaultModelId: null });
    assert.equal(services.get("correction").defaultModelId, two.id);
    assert.equal(getDefaultRoleProfile(db, "acopilot")?.model_id, "");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});
