import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { handleAudioRoutes } from "../../src/web/server/api/routes/audio.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createReq(body: Buffer, contentType = "audio/webm"): FakeReq {
  return {
    method: "POST",
    headers: { "content-type": contentType },
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) {
        yield body;
      }
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

function parseJson(body: string): unknown {
  return body ? (JSON.parse(body) as unknown) : null;
}

describe("web/server/api/routes/audio", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("returns false for non-matching routes", async () => {
    const req = createReq(Buffer.from("x"));
    const res = createRes();
    const handled = await handleAudioRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/other"),
        pathname: "/api/other",
        auth: { userId: "u", username: "t" },
      } as any,
      { logger: { warn: () => {} } },
    );
    assert.equal(handled, false);
    assert.equal(res.statusCode, null);
  });

  it("rejects empty audio", async () => {
    const req = createReq(Buffer.alloc(0));
    const res = createRes();
    const handled = await handleAudioRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/audio/transcriptions"),
        pathname: "/api/audio/transcriptions",
        auth: { userId: "u", username: "t" },
      } as any,
      { logger: { warn: () => {} } },
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parseJson(res.body), { error: "音频为空" });
  });

  it("transcribes via Together", async () => {
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER = "together";

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      assert.ok(url.includes("api.together.xyz/v1/audio/transcriptions"));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "hello" }),
      } as any;
    }) as any;

    const req = createReq(Buffer.from("abc"));
    const res = createRes();
    const handled = await handleAudioRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/audio/transcriptions"),
        pathname: "/api/audio/transcriptions",
        auth: { userId: "u", username: "t" },
      } as any,
      { logger: { warn: () => {} } },
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseJson(res.body), { ok: true, text: "hello" });
  });

  it("returns 504 when upstream times out", async () => {
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.ADS_TOGETHER_AUDIO_TIMEOUT_MS = "1";

    globalThis.fetch = ((_: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }) as any;

    const req = createReq(Buffer.from("abc"));
    const res = createRes();
    const warnings: string[] = [];
    const handled = await handleAudioRoutes(
      {
        req: req as any,
        res: res as any,
        url: new URL("http://localhost/api/audio/transcriptions"),
        pathname: "/api/audio/transcriptions",
        auth: { userId: "u", username: "t" },
      } as any,
      { logger: { warn: (msg: string) => warnings.push(msg) } },
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 504);
    assert.deepEqual(parseJson(res.body), { error: "语音识别超时" });
    assert.ok(warnings.length >= 1);
  });
});
