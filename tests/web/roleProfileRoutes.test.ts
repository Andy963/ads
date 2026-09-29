import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";

import { getStateDatabase } from "../../server/state/database.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { getDefaultRoleProfile } from "../../server/state/roleProfileStore.js";
import { handleRoleProfileRoutes } from "../../server/web/server/api/routes/roleProfiles.js";
import type { ApiRouteContext } from "../../server/web/server/api/types.js";

it("saves role model, effort and instructions independently through the real HTTP route", async () => {
  const db = getStateDatabase();
  const store = createGlobalModelConfigStore(db);
  const model = store.upsertModelConfig({ id: "role-catalog-id", modelId: "legacy-model-name", displayName: "Model alias", provider: "openai", isEnabled: true, isDefault: true });
  createModelServiceStore(db).save("conversation", [model.id], model.id);
  const profile = getDefaultRoleProfile(db, "developer")!;
  db.prepare("UPDATE role_profiles SET model_id = ? WHERE id = ?").run(model.modelId, profile.id);
  const count = db.prepare("SELECT count(*) AS total FROM role_profiles").get();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleRoleProfileRoutes({ req, res, url, pathname: url.pathname, auth: { userId: "test", username: "test" } } as ApiRouteContext)
      .catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function update(body: unknown) {
    const response = await fetch(origin + "/api/role-profiles/" + profile.id, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const saved = await update({ model_id: model.id });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.model_id, model.id);
    assert.equal(saved.body.system_prompt, profile.system_prompt);
    assert.equal(saved.body.id, profile.id);
    const effort = await update({ reasoning_effort: "medium" });
    assert.equal(effort.status, 200);
    assert.equal(effort.body.model_id, model.id);
    assert.equal(effort.body.system_prompt, profile.system_prompt);
    const invalid = await update({ model_id: "missing" });
    assert.equal(invalid.status, 400);
    assert.equal(getDefaultRoleProfile(db, "developer")?.model_id, model.id);
    createModelServiceStore(db).save("conversation", [], null);
    const prompt = await update({ system_prompt: "Edited instructions" });
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.system_prompt, "Edited instructions");
    assert.equal(prompt.body.reasoning_effort, "medium");
    assert.deepEqual(db.prepare("SELECT count(*) AS total FROM role_profiles").get(), count);
    const readBack = await fetch(origin + "/api/role-profiles").then(response => response.json());
    assert.equal(readBack.find((item: { id: string }) => item.id === profile.id).model_id, model.id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
