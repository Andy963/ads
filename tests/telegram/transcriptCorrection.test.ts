import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { correctTranscriptWithModel } from "../../src/telegram/utils/transcriptCorrection.js";

describe("telegram/transcriptCorrection", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("corrects transcript via Groq chat completions", async () => {
    process.env.GROQ_API_KEY = "groq-test";
    process.env.ADS_TELEGRAM_VOICE_CORRECTION_MODEL = "llama-3.1-8b-instant";

    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      assert.ok(url.includes("api.groq.com/openai/v1/chat/completions"));
      const payload = init?.body ? (JSON.parse(init.body) as any) : null;
      assert.equal(payload.model, "llama-3.1-8b-instant");
      assert.equal(payload.temperature, 0);
      assert.ok(Array.isArray(payload.messages));
      assert.equal(payload.messages[0].role, "system");
      assert.equal(payload.messages[1].role, "user");
      assert.equal(payload.messages[1].content, "raw transcript");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "Fixed transcript" } }] }),
      } as any;
    }) as any;

    const result = await correctTranscriptWithModel({ transcript: "raw transcript" });
    assert.deepEqual(result, { ok: true, text: "Fixed transcript", corrected: true });
  });

  it("skips correction when disabled", async () => {
    process.env.GROQ_API_KEY = "groq-test";
    process.env.ADS_TELEGRAM_VOICE_CORRECTION_ENABLED = "0";

    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as any;

    const result = await correctTranscriptWithModel({ transcript: " raw transcript " });
    assert.deepEqual(result, { ok: true, text: "raw transcript", corrected: false });
  });
});

