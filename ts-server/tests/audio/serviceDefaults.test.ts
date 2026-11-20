import assert from "node:assert/strict";
import { it } from "node:test";
import Database from "better-sqlite3";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { createVoiceSettingsStore } from "../../server/audio/settings.js";
import { transcribeAudioBuffer } from "../../server/audio/transcription.js";

it("calls only each service default and pins the correction selection before transcription", async () => {
  const db = new Database(":memory:");
  try {
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-pepper" });
    const settings = createVoiceSettingsStore(db, credentials);
    const services = createModelServiceStore(db);
    const models = createGlobalModelConfigStore(db);
    const providers = createModelProviderStore(db);
    for (const id of ["one", "two"]) {
      providers.upsertProvider({ id, name: id, baseUrl: "https://" + id + ".invalid/v1", isEnabled: true });
      credentials.save("owner", { provider: id, baseUrl: "https://" + id + ".invalid/v1", apiKey: "key-" + id }, id);
      for (const type of ["asr", "correct"]) models.upsertModelConfig({ id: type + "-" + id, modelId: type,
        displayName: type, provider: id, providerId: id, isEnabled: true, isDefault: false });
    }
    services.save("transcription", ["asr-one", "asr-two"], "asr-two");
    services.save("correction", ["correct-one", "correct-two"], "correct-one");
    settings.saveCorrection("owner", { config: { ...settings.get("owner").config.correction, enabled: true } });
    const calls: string[] = [];
    const result = await transcribeAudioBuffer({ owner: "owner", audio: Buffer.from("fixture"), contentType: "audio/webm", settingsStore: settings,
      provider: async request => {
        calls.push("asr:" + request.connection.provider);
        assert.equal(request.model, "asr");
        assert.equal(request.connection.apiKey, "key-two");
        services.save("correction", ["correct-one", "correct-two"], "correct-two");
        return "raw text";
      },
      completeImpl: async request => {
        calls.push("correct:" + request.baseUrl);
        assert.equal(request.model, "correct");
        assert.equal(request.apiKey, "key-one");
        return { text: "corrected text", toolCalls: [], finishReason: "stop", usage: null };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["asr:two", "correct:https://one.invalid/v1"]);
    assert.equal(settings.resolve("owner").correction?.apiKey, "key-two");
    const record = JSON.parse((db.prepare("SELECT value FROM kv_state WHERE namespace = 'voice_settings' AND key = 'owner'").get() as { value: string }).value);
    assert.equal(record.version, 2);
    for (const stage of [record.config.transcription, record.config.correction]) {
      for (const key of ["model", "provider", "providerId", "baseUrl", "apiKey"]) assert.equal(key in stage, false);
    }
    assert.deepEqual(services.get("conversation").modelIds, []);
    providers.upsertProvider({ ...providers.getProvider("two")!, baseUrl: "https://changed.invalid/v1" });
    assert.equal(settings.get("owner").configured, false);
    assert.equal(settings.get("owner").hasApiKey, false);
    assert.throws(() => settings.resolve("owner"), /endpoint/);
    providers.upsertProvider({ ...providers.getProvider("two")!, isEnabled: false });
    assert.throws(() => settings.resolve("owner"), /default/);
  } finally { db.close(); }
});
