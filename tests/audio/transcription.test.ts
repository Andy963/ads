import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { transcribeAudioBuffer } from "../../src/audio/transcription.js";

describe("audio/transcription", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("uses Together whisper-large-v3 when preferred", async () => {
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER = "together";

    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      assert.ok(url.includes("api.together.xyz/v1/audio/transcriptions"));
      const body = init?.body as FormData;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("model"), "openai/whisper-large-v3");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "hello" }),
      } as any;
    }) as any;

    const result = await transcribeAudioBuffer({ audio: Buffer.from("abc"), contentType: "audio/ogg" });
    assert.deepEqual(result, { ok: true, text: "hello", provider: "together" });
  });

  it("falls back from OpenAI to Together when OpenAI key is missing", async () => {
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER = "openai";

    let calls = 0;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      calls += 1;
      assert.ok(url.includes("api.together.xyz/v1/audio/transcriptions"));
      const body = init?.body as FormData;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("model"), "openai/whisper-large-v3");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "ok" }),
      } as any;
    }) as any;

    const result = await transcribeAudioBuffer({ audio: Buffer.from("abc"), contentType: "audio/ogg" });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.provider, "together");
    assert.equal(result.ok && result.text, "ok");
  });
});
