import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { transcribeTelegramVoiceMessage } from "../../src/telegram/utils/voiceTranscription.js";

describe("telegram/voiceTranscription", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("transcribes voice and combines caption", async () => {
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER = "together";

    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body as FormData;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("model"), "openai/whisper-large-v3");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "hello world" }),
      } as any;
    }) as any;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tg-voice-"));
    const audioPath = path.join(tmpDir, "voice.ogg");
    fs.writeFileSync(audioPath, Buffer.from("abc"));

    const text = await transcribeTelegramVoiceMessage({
      api: { token: "x" } as any,
      fileId: "file-id",
      mimeType: "audio/ogg",
      caption: "caption",
      downloadFile: async () => audioPath,
      readFile: async () => Buffer.from("abc"),
    });

    assert.equal(text, "caption\n\nhello world");
  });
});

