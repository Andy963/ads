import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createVoiceSettingsStore, defaultVoiceConfig } from "../../server/audio/settings.js";
import { transcribeAudioBuffer } from "../../server/audio/transcription.js";
import { transcribeWithGroq, AudioError } from "../../server/audio/provider.js";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../shared/voice.js";

const complete = (text: string) => ({ text, toolCalls: [], finishReason: "stop", usage: null });

describe("built-in voice service", () => {
  let directory: string;
  let db: Database.Database;
  let credentials: ReturnType<typeof createUpstreamCredentialStore>;
  let store: ReturnType<typeof createVoiceSettingsStore>;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-voice-"));
    db = new Database(path.join(directory, "state.db"));
    db.pragma("journal_mode = WAL");
    credentials = createUpstreamCredentialStore(db, { pepper: "fixture-pepper" });
    store = createVoiceSettingsStore(db, credentials);
    store.save("alice", { config: asrConfig(defaultVoiceConfig()), apiKey: "asr-private-fixture-key" });
  });
  afterEach(() => { mock.restoreAll(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function correction(endpoint = "https://llm-a.invalid/v1", apiKey = "correction-private-key") {
    const config = { ...defaultVoiceConfig().correction, enabled: true, baseUrl: endpoint, model: "shared-name", timeoutMs: 1000 };
    const selected = store.get("alice").config.correction.providerId;
    if (selected) {
      const provider = createModelProviderStore(db).getProvider(selected)!;
      createModelProviderStore(db).upsertProvider({ ...provider, baseUrl: endpoint });
      credentials.save("alice", { provider: provider.id, baseUrl: endpoint, apiKey }, provider.credentialProfile || provider.id);
    }
    store.saveCorrection("alice", { config, apiKey });
    return config;
  }
  function asrConfig(value = store.get("alice").config) {
    return { enabled: value.enabled, transcription: value.transcription, totalTimeoutMs: value.totalTimeoutMs };
  }
  function transcribe(extra: Partial<Parameters<typeof transcribeAudioBuffer>[0]> = {}) {
    return transcribeAudioBuffer({ owner: "alice", audio: Buffer.from("fixture-audio"), contentType: "audio/webm;codecs=opus", settingsStore: store, provider: async () => "raw transcript", ...extra });
  }

  it("persists encrypted owner-isolated settings without discovery and never stores the key in database/WAL or metadata", () => {
    const reopened = createVoiceSettingsStore(db, credentials);
    assert.equal(reopened.get("alice").configured, true);
    assert.equal(reopened.get("bob").configured, false);
    assert.equal(reopened.get("bob").hasApiKey, false);
    assert.throws(() => reopened.resolve("bob"), /API 密钥/);
    assert.equal(reopened.resolve("alice").transcription.apiKey, "asr-private-fixture-key");
    assert.doesNotMatch(JSON.stringify(reopened.get("alice")), /asr-private-fixture-key/);
    for (const suffix of ["", "-wal"]) assert.ok(!fs.readFileSync(db.name + suffix).includes(Buffer.from("asr-private-fixture-key")));
  });

  it("requires a new key on endpoint changes, preserves unrelated profiles, and rejects credential-bearing URLs", () => {
    credentials.save("alice", { baseUrl: "https://other.invalid/v1", provider: "other", apiKey: "unrelated-key" }, "other");
    const config = asrConfig();
    config.transcription.baseUrl = "https://replacement.invalid/v1";
    assert.throws(() => store.save("alice", { config }), /provider settings/);
    assert.equal(store.resolve("alice").transcription.baseUrl, "https://api.groq.com/openai/v1");
    assert.throws(() => store.save("alice", { config, apiKey: "replacement-key" }), /provider settings/);
    const provider = createModelProviderStore(db).getProvider(store.get("alice").config.transcription.providerId!)!;
    createModelProviderStore(db).upsertProvider({ ...provider, baseUrl: config.transcription.baseUrl });
    credentials.save("alice", { provider: provider.id, baseUrl: config.transcription.baseUrl, apiKey: "replacement-key" }, provider.credentialProfile || provider.id);
    assert.equal(store.resolve("alice").transcription.apiKey, "replacement-key");
    assert.equal(credentials.getCredentials("alice", "other")?.apiKey, "unrelated-key");
    for (const url of ["file:///tmp/audio", "https://user:secret@example.invalid", "https://x.invalid?key=secret"]) {
      config.transcription.baseUrl = url;
      assert.throws(() => store.save("alice", { config, apiKey: "new-key" }));
    }
    assert.equal(store.resolve("alice").transcription.apiKey, "replacement-key");
  });

  it("pins the independent correction connection before the asynchronous ASR stage", async () => {
    const config = correction();
    config.systemPrompt = "Fix transcription errors.\nPreserve product names and all original meaning.";
    store.saveCorrection("alice", { config });
    const result = await transcribe({
      provider: async () => {
        correction("https://changed.invalid/v1", "changed-key");
        return "raw transcript";
      },
      completeImpl: async (request) => {
        assert.equal(request.model, "shared-name");
        assert.equal(request.baseUrl, "https://llm-a.invalid/v1");
        assert.equal(request.apiKey, "correction-private-key");
        assert.deepEqual(request.tools, []);
        assert.equal(request.streaming, false);
        assert.equal(request.options?.reasoningEffort, "high");
        assert.equal(request.messages.length, 2);
        assert.deepEqual(request.messages[0], { role: "system", content: config.systemPrompt });
        assert.equal(request.messages[1]?.content, "raw transcript");
        return complete("corrected transcript");
      },
    });
    assert.ok(result.ok);
    assert.equal(result.text, "corrected transcript");
    assert.equal(result.correction.status, "completed");
    assert.equal(result.corrected, true);
    assert.notEqual(store.get("alice").config.correction.systemPrompt, config.systemPrompt);
  });

  it("persists custom prompts, rejects invalid replacements, and defaults only a missing legacy field", () => {
    const config = correction();
    config.systemPrompt = "  Correct only spelling.\nKeep line breaks.  ";
    store.saveCorrection("alice", { config });
    const reopened = createVoiceSettingsStore(db, credentials);
    assert.equal(reopened.get("alice").config.correction.systemPrompt, config.systemPrompt);
    assert.equal(reopened.get("bob").config.correction.systemPrompt, DEFAULT_CORRECTION_SYSTEM_PROMPT);
    for (const systemPrompt of ["", " \n\t ", "x".repeat(8001)]) {
      assert.throws(() => store.saveCorrection("alice", { config: { ...config, systemPrompt } }));
      assert.equal(store.get("alice").config.correction.systemPrompt, config.systemPrompt);
    }
    const row = db.prepare("SELECT value FROM kv_state WHERE namespace = 'voice_settings' AND key = 'alice'").get() as { value: string };
    const record = JSON.parse(row.value);
    delete record.config.correction.systemPrompt;
    db.prepare("UPDATE kv_state SET value = ? WHERE namespace = 'voice_settings' AND key = 'alice'").run(JSON.stringify(record));
    const migrated = reopened.get("alice");
    assert.equal(migrated.recoveryRequired, undefined);
    assert.equal(migrated.config.correction.systemPrompt, DEFAULT_CORRECTION_SYSTEM_PROMPT);
    assert.equal(reopened.resolve("alice").correction?.apiKey, "correction-private-key");
    assert.equal(reopened.resolve("alice").transcription.apiKey, "asr-private-fixture-key");
  });

  it("distinguishes disabled and successful unchanged correction", async () => {
    let calls = 0;
    const completeImpl = async () => { calls++; return complete("raw transcript"); };
    const disabled = await transcribe({ completeImpl });
    assert.ok(disabled.ok);
    assert.equal(disabled.correction.status, "disabled");
    assert.equal(calls, 0);
    correction();
    const unchanged = await transcribe({ completeImpl });
    assert.ok(unchanged.ok);
    assert.equal(unchanged.correction.status, "completed");
    assert.equal(unchanged.corrected, false);
    assert.equal(calls, 1);
  });

  it("retains raw text for empty, truncated, failed or undecryptable correction", async () => {
    correction();
    for (const completeImpl of [async () => complete(""), async () => ({ ...complete("partial transcript"), finishReason: "length" }), async () => { throw new Error("PRIVATE-KEY TRANSCRIPT upstream body"); }]) {
      const result = await transcribe({ completeImpl });
      assert.ok(result.ok);
      assert.equal(result.text, "raw transcript");
      assert.equal(result.correction.status, "failed");
      assert.doesNotMatch(JSON.stringify(result.correction), /PRIVATE-KEY|upstream body/);
    }
    const row = db.prepare("SELECT value FROM kv_state WHERE namespace = 'voice_settings' AND key = 'alice'").get() as { value: string };
    assert.equal(JSON.parse(row.value).version, 2);
    credentials.save("alice", { provider: "openai", baseUrl: "https://wrong.invalid/v1", apiKey: "wrong-key" }, createModelProviderStore(db).getProvider(store.get("alice").config.correction.providerId!)!.credentialProfile!);
    const result = await transcribe({ completeImpl: async () => { throw new Error("must not call"); } });
    assert.ok(result.ok);
    assert.equal(result.correction.status, "failed");
    assert.equal(result.text, "raw transcript");
  });

  it("saves correction before ASR, keeps credentials private and leaves conversation models untouched", () => {
    const models = createGlobalModelConfigStore(db);
    models.upsertModelConfig({ id: "chat", modelId: "shared-name", displayName: "Chat", provider: "openai", isEnabled: true, isDefault: true });
    credentials.save("alice", { provider: "openai", baseUrl: "https://chat.invalid/v1", apiKey: "chat-key" });
    const before = models.listModelConfigs();
    const config = correction();
    store.saveCorrection("bob", { config, apiKey: "bob-private-key" });
    assert.equal(store.get("bob").configured, false);
    assert.equal(store.get("bob").hasApiKey, false);
    assert.equal(store.get("bob").correctionHasApiKey, true);
    assert.equal(store.resolve("alice").correction?.apiKey, "correction-private-key");
    for (const original of before) assert.deepEqual(models.getModelConfig(original.id), original);
    assert.deepEqual(createModelServiceStore(db).get("conversation").modelIds, []);
    assert.equal(credentials.getCredentials("alice")?.apiKey, "chat-key");
    assert.equal(store.resolve("alice").transcription.apiKey, "asr-private-fixture-key");
    const reopened = createVoiceSettingsStore(db, credentials);
    assert.equal(reopened.get("alice").correctionHasApiKey, true);
    assert.equal(reopened.get("charlie").correctionHasApiKey, false);
    for (const key of ["correction-private-key", "bob-private-key"]) {
      assert.doesNotMatch(JSON.stringify(reopened.get("alice")), new RegExp(key));
      for (const suffix of ["", "-wal"]) assert.ok(!fs.readFileSync(db.name + suffix).includes(Buffer.from(key)));
    }
  });

  it("requires an explicit new correction key for endpoint changes and rejects secret-bearing URLs", () => {
    const config = correction();
    config.baseUrl = "https://replacement.invalid/v1";
    assert.throws(() => store.saveCorrection("alice", { config }), /provider settings/);
    assert.equal(store.resolve("alice").correction?.apiKey, "correction-private-key");
    assert.throws(() => store.saveCorrection("alice", { config, apiKey: "replacement-key" }), /provider settings/);
    const provider = createModelProviderStore(db).getProvider(store.get("alice").config.correction.providerId!)!;
    createModelProviderStore(db).upsertProvider({ ...provider, baseUrl: config.baseUrl });
    credentials.save("alice", { provider: provider.id, baseUrl: config.baseUrl, apiKey: "replacement-key" }, provider.credentialProfile || provider.id);
    assert.equal(store.resolve("alice").correction?.apiKey, "replacement-key");
    for (const baseUrl of ["file:///tmp/x", "https://user:secret@example.invalid", "https://x.invalid?api_key=secret", "https://x.invalid#secret"]) {
      assert.throws(() => store.saveCorrection("alice", { config: { ...config, baseUrl }, apiKey: "new-key" }));
    }
    assert.equal(store.resolve("alice").correction?.baseUrl, "https://replacement.invalid/v1");
    assert.equal(store.resolve("alice").transcription.apiKey, "asr-private-fixture-key");
  });

  it("saves only the edited section and never clobbers the other section from a stale form", () => {
    const staleAsr = asrConfig();
    const config = correction();
    config.reasoningEffort = "low";
    store.saveCorrection("alice", { config });
    staleAsr.transcription.language = "en";
    store.save("alice", { config: staleAsr });
    assert.equal(store.get("alice").config.correction.reasoningEffort, "low");
    config.model = "new-model";
    store.saveCorrection("alice", { config });
    assert.equal(store.get("alice").config.transcription.language, "en");
    assert.equal(store.resolve("alice").correction?.options?.reasoningEffort, "low");
    assert.throws(() => store.save("alice", { config: { ...staleAsr, correction: config } } as any));
  });

  it("preserves legacy ASR settings without borrowing a legacy conversation connection", async () => {
    const models = createGlobalModelConfigStore(db);
    models.upsertModelConfig({ id: "legacy-model", modelId: "legacy", displayName: "Legacy", provider: "openai", isEnabled: true, isDefault: true });
    credentials.save("alice", { provider: "openai", baseUrl: "https://legacy.invalid/v1", apiKey: "legacy-key" });
    const provider = createModelProviderStore(db).getProvider(store.get("alice").config.transcription.providerId!)!;
    const record = { config: { ...store.get("alice").config,
      transcription: { ...store.get("alice").config.transcription, providerId: null },
      correction: { enabled: true, modelConfigId: "legacy-model", timeoutMs: 1000 } },
      credentialProfile: provider.credentialProfile };
    db.prepare("UPDATE kv_state SET value = ? WHERE namespace = 'voice_settings' AND key = 'alice'").run(JSON.stringify(record));
    assert.equal(store.get("alice").hasApiKey, true);
    assert.equal(store.get("alice").correctionHasApiKey, false);
    assert.equal(store.get("alice").config.correction.baseUrl, "");
    store.save("alice", { config: asrConfig() });
    const result = await transcribe({ completeImpl: async () => { throw new Error("must not call"); } });
    assert.ok(result.ok);
    assert.equal(result.correction.status, "failed");
    assert.equal(result.text, "raw transcript");
    correction();
    assert.equal(store.resolve("alice").correction?.apiKey, "correction-private-key");
    assert.equal(credentials.getCredentials("alice")?.apiKey, "legacy-key");
    assert.equal(models.getModelConfig("legacy-model")?.modelId, "legacy");
  });

  it("repairs corrupt saved configuration only with an explicit replacement key and can disable an undecryptable profile", () => {
    const config = asrConfig();
    db.prepare("UPDATE kv_state SET value = 'invalid' WHERE namespace = 'voice_settings'").run();
    assert.equal(store.get("alice").recoveryRequired, true);
    assert.throws(() => store.save("alice", { config }));
    store.save("alice", { config, apiKey: "repair-key" });
    assert.equal(store.resolve("alice").transcription.apiKey, "repair-key");
    const wrongStore = createVoiceSettingsStore(db, createUpstreamCredentialStore(db, { pepper: "wrong-pepper" }));
    config.enabled = false;
    wrongStore.save("alice", { config });
    assert.equal(wrongStore.get("alice").config.enabled, false);
    assert.throws(() => wrongStore.resolve("alice"), /已禁用/);
  });

  it("aborts both upstream stages on cancellation and records only safe timing metadata", async () => {
    correction();
    for (const stage of ["transcription", "correction"]) {
      const controller = new AbortController();
      const logs: string[] = [];
      const entered = Promise.withResolvers<void>();
      const waitForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
        entered.resolve();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const pending = transcribe({ signal: controller.signal, logger: { info: (line) => logs.push(line) },
        provider: async (request) => stage === "transcription" ? waitForAbort(request.signal) : "private transcript",
        completeImpl: async (request) => waitForAbort(request.signal!),
      });
      await entered.promise;
      controller.abort(new Error("cancelled"));
      await assert.rejects(pending, /cancelled/);
      assert.match(logs.join(""), /status=cancelled.*transcription_ms=.*correction_ms=.*total_ms=/);
      assert.doesNotMatch(logs.join(""), /private transcript|private-key/);
    }
  });

  it("retains raw text on correction deadline, but fails safely on transcription deadline", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    correction();
    const entered = Promise.withResolvers<void>();
    const pending = transcribe({ completeImpl: async (request) => new Promise((_, reject) => {
      entered.resolve(); request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    }) });
    await entered.promise;
    context.mock.timers.tick(1000);
    const result = await pending;
    assert.ok(result.ok);
    assert.equal(result.text, "raw transcript");
    assert.equal(result.correction.status, "failed");
    assert.match(result.correction.warning!, /超时/);
    const asr = transcribe({ provider: async (request) => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }) });
    context.mock.timers.tick(120_000);
    const failed = await asr;
    assert.ok(!failed.ok);
    assert.equal(failed.status, 504);
  });

  it("fails closed for disabled, missing, or undecryptable voice configuration", async () => {
    const config = asrConfig();
    config.enabled = false;
    store.save("alice", { config });
    assert.ok(!(await transcribe()).ok);
    config.enabled = true;
    store.save("alice", { config });
    const wrongStore = createVoiceSettingsStore(db, createUpstreamCredentialStore(db, { pepper: "wrong-pepper" }));
    const failure = await transcribe({ settingsStore: wrongStore });
    assert.ok(!failure.ok);
    assert.equal(failure.status, 409);
  });

  it("transcribes natively with filesystem and process APIs forbidden", async () => {
    const connection = store.resolve("alice");
    const resolvedStore = { resolve: () => connection } as typeof store;
    for (const method of ["writeFileSync", "mkdtempSync", "readdirSync"] as const) mock.method(fs, method, () => { throw new Error("filesystem forbidden"); });
    for (const method of ["spawn", "spawnSync", "exec", "execFile"] as const) mock.method(childProcess, method, () => { throw new Error("process forbidden"); });
    const result = await transcribe({ settingsStore: resolvedStore, provider: (request) => transcribeWithGroq(request, async () => Response.json({ text: "native output" })) });
    assert.ok(result.ok);
    assert.equal(result.text, "native output");
  });
});

describe("Groq multipart provider", () => {
  const base = { audio: Buffer.from("audio-bytes"), contentType: "audio/webm;codecs=opus", model: "whisper-large-v3", language: "zh", prompt: "technical terms", connection: { baseUrl: "https://api.groq.com/openai/v1", provider: "groq", apiKey: "fixture-key" }, signal: new AbortController().signal };
  it("sends baseline and turbo models with WebM and iOS M4A MIME/filename alignment", async () => {
    for (const [model, contentType, filename] of [["whisper-large-v3", "audio/webm;codecs=opus", "recording.webm"], ["whisper-large-v3-turbo", "audio/mp4", "recording.m4a"]]) {
      const result = await transcribeWithGroq({ ...base, model: model!, contentType: contentType! }, async (url, init) => {
        assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.signal, base.signal);
        const form = init?.body as FormData;
        assert.equal(form.get("model"), model);
        assert.equal(form.get("language"), "zh");
        assert.equal(form.get("prompt"), "technical terms");
        const file = form.get("file") as File;
        assert.equal(file.name, filename);
        assert.equal(file.type, contentType!.split(";")[0]);
        assert.equal(await file.text(), "audio-bytes");
        return Response.json({ text: "hello" });
      });
      assert.equal(result, "hello");
    }
  });
  it("rejects invalid audio before upload and handles safe upstream failure classes", async () => {
    for (const input of [{ audio: Buffer.alloc(0) }, { audio: Buffer.alloc(25 * 1024 * 1024 + 1) }, { contentType: "text/plain" }]) {
      await assert.rejects(transcribeWithGroq({ ...base, ...input }, async () => { throw new Error("must not upload"); }), AudioError);
    }
    for (const status of [400, 401, 403, 413, 415, 429, 500]) {
      await assert.rejects(transcribeWithGroq(base, async () => new Response("private raw body", { status })), (error: Error) => !error.message.includes("private raw body"));
    }
    for (const response of [new Response("not JSON"), Response.json({ text: " " }), Response.json({ wrong: "field" }), new Response("x".repeat(256 * 1024 + 1))]) {
      await assert.rejects(transcribeWithGroq(base, async () => response), AudioError);
    }
  });
});
