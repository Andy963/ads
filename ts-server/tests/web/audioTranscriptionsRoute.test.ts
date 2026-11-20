import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { handleAudioRoutes } from "../../server/web/server/api/routes/audio.js";
import { createVoiceSettingsStore, defaultVoiceConfig } from "../../server/audio/settings.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import type { ApiRouteContext } from "../../server/web/server/api/types.js";

function context(pathname = "/api/audio/transcriptions", method = "POST", body = Buffer.from("audio"), owner = "alice") {
  const req = Object.assign(new EventEmitter(), {
    method, headers: { "content-type": "audio/mp4;codecs=mp4a.40.2" }, aborted: false,
    async *[Symbol.asyncIterator]() { yield body; },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, body: "", headers: {} as Record<string, string>, writableEnded: false,
    setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; },
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(value: string) { this.body = value; this.writableEnded = true; },
  });
  return { req, res, pathname, url: new URL(pathname, "http://localhost"), auth: { userId: owner, username: owner } };
}
const logger = { warn() {} };

describe("voice routes", () => {
  it("saves correction independently with owner isolation and no model registration endpoint", async () => {
    const db = new Database(":memory:");
    try {
      const store = createVoiceSettingsStore(db, createUpstreamCredentialStore(db, { pepper: "fixture" }));
      const config = { ...defaultVoiceConfig().correction, enabled: true, baseUrl: "https://correction.invalid/v1", model: "own-model" };
      const save = context("/api/voice/correction", "PUT", Buffer.from(JSON.stringify({ config, apiKey: "private-key" })));
      await handleAudioRoutes(save as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(save.res.statusCode, 200);
      assert.doesNotMatch(save.res.body, /private-key/);
      assert.equal(JSON.parse(save.res.body).correctionHasApiKey, true);
      assert.equal(JSON.parse(save.res.body).hasApiKey, false);
      const malicious = context("/api/voice/correction", "PUT", Buffer.from(JSON.stringify({ owner: "alice", config, apiKey: "attacker" })), "bob");
      await handleAudioRoutes(malicious as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(malicious.res.statusCode, 400);
      assert.equal(store.get("bob").correctionHasApiKey, false);
      const unauthenticated = context("/api/voice/correction", "PUT", Buffer.from(JSON.stringify({ config })), "");
      await handleAudioRoutes(unauthenticated as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(unauthenticated.res.statusCode, 401);
      const oldRoute = context("/api/voice/correction-models", "POST");
      assert.equal(await handleAudioRoutes(oldRoute as unknown as ApiRouteContext, { logger, settingsStore: store }), false);
    } finally { db.close(); }
  });

  it("preserves ok/text while passing authenticated owner and cancellation and returning correction metadata", async () => {
    const ctx = context();
    const response = { ok: true as const, text: "hello", provider: "groq", corrected: false, correction: { status: "completed" as const }, timings: { transcriptionMs: 1, correctionMs: 2, totalMs: 3 } };
    await handleAudioRoutes(ctx as unknown as ApiRouteContext, { logger, transcribeAudioBuffer: async (request) => {
      assert.equal(request.owner, "alice");
      assert.ok(request.signal);
      assert.equal(request.contentType, "audio/mp4;codecs=mp4a.40.2");
      return response;
    } });
    assert.equal(ctx.res.statusCode, 200);
    assert.deepEqual(JSON.parse(ctx.res.body), response);
    assert.equal(ctx.req.listenerCount("aborted"), 0);
    assert.equal(ctx.res.listenerCount("close"), 0);
  });
  it("aborts pending upstream work on disconnect and tears down listeners without writing a stale response", async () => {
    const ctx = context();
    const entered = Promise.withResolvers<AbortSignal>();
    const pending = handleAudioRoutes(ctx as unknown as ApiRouteContext, { logger, transcribeAudioBuffer: async (request) => {
      entered.resolve(request.signal!);
      return new Promise((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
    } });
    const signal = await entered.promise;
    ctx.res.emit("close");
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(ctx.res.body, "");
    assert.equal(ctx.req.listenerCount("aborted"), 0);
    assert.equal(ctx.res.listenerCount("close"), 0);
  });
  it("returns safe upload, timeout and provider errors", async () => {
    const large = context(undefined, undefined, Buffer.alloc(25 * 1024 * 1024 + 1));
    await handleAudioRoutes(large as unknown as ApiRouteContext, { logger, transcribeAudioBuffer: async () => { throw new Error("must not upload"); } });
    assert.equal(large.res.statusCode, 413);
    const ctx = context();
    await handleAudioRoutes(ctx as unknown as ApiRouteContext, { logger, transcribeAudioBuffer: async () => ({ ok: false, error: "Timed out", timedOut: true, status: 504 }) });
    assert.equal(ctx.res.statusCode, 504);
    const unexpected = context();
    await handleAudioRoutes(unexpected as unknown as ApiRouteContext, { logger, transcribeAudioBuffer: async () => { throw new Error("private-key raw body"); } });
    assert.equal(unexpected.res.statusCode, 502);
    assert.doesNotMatch(unexpected.res.body, /private-key|raw body/);
  });
  it("saves without model discovery, isolates metadata by auth owner and rejects client owner injection", async () => {
    const db = new Database(":memory:");
    try {
      const store = createVoiceSettingsStore(db, createUpstreamCredentialStore(db, { pepper: "fixture" }));
      const defaults = defaultVoiceConfig();
      const config = { enabled: defaults.enabled, transcription: defaults.transcription, totalTimeoutMs: defaults.totalTimeoutMs };
      const save = context("/api/voice/settings", "PUT", Buffer.from(JSON.stringify({ config, apiKey: "private-key" })));
      await handleAudioRoutes(save as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(save.res.statusCode, 200);
      assert.doesNotMatch(save.res.body, /private-key/);
      assert.equal(JSON.parse(save.res.body).hasApiKey, true);
      const read = context("/api/voice/settings", "GET", undefined, "bob");
      await handleAudioRoutes(read as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(JSON.parse(read.res.body).hasApiKey, false);
      const malicious = context("/api/voice/settings", "PUT", Buffer.from(JSON.stringify({ owner: "alice", config, apiKey: "attacker" })), "bob");
      await handleAudioRoutes(malicious as unknown as ApiRouteContext, { logger, settingsStore: store });
      assert.equal(malicious.res.statusCode, 400);
      assert.equal(store.resolve("alice").transcription.apiKey, "private-key");
      assert.equal(read.res.headers["cache-control"], "no-store");
    } finally { db.close(); }
  });
});
