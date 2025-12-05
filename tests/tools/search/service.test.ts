import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { search } from "../../../src/tools/search/service.js";
import { resolveSearchConfig } from "../../../src/tools/search/config.js";
import type { TavilyClientAdapter } from "../../../src/tools/search/client.js";

const tmpLog = path.join(".tmp", "tavily-search-test.log");

function cleanupLog(): void {
  try {
    fs.rmSync(tmpLog, { force: true });
  } catch {
    // ignore
  }
}

function makeFactory(
  handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>>,
): (apiKey: string) => Promise<TavilyClientAdapter> {
  return async (apiKey: string) => {
    return {
      search: async (payload: Record<string, unknown>) => {
        const handler = handlers[apiKey];
        if (!handler) {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        }
        return handler(payload);
      },
    };
  };
}

describe("search service", () => {
  beforeEach(() => {
    cleanupLog();
  });

  it("returns config error when no keys are provided", async () => {
    await assert.rejects(
      () =>
        search(
          { query: "hello world" },
          { config: resolveSearchConfig({ apiKeys: [], logPath: tmpLog, retries: 0 }) },
        ),
      (error: any) => {
        assert.equal(error.type, "config");
        return true;
      },
    );
  });

  it("clips maxResults to limit and returns structured response", async () => {
    const factory = makeFactory({
      key1: async () => ({
        results: Array.from({ length: 12 }).map((_, i) => ({
          title: `title-${i}`,
          url: `https://example.com/${i}`,
          content: `content-${i}`,
          score: i,
        })),
      }),
    });

    const res = await search(
      { query: "demo", maxResults: 25 },
      { config: resolveSearchConfig({ apiKeys: ["key1"], logPath: tmpLog }), clientFactory: factory },
    );

    assert.equal(res.results.length, 10);
    assert.equal(res.meta.total, 12);
    assert.equal(res.results[0].source, "tavily");

    const logText = fs.readFileSync(tmpLog, "utf-8").trim().split("\n");
    assert.ok(logText.length >= 1);
    const entry = JSON.parse(logText[0]);
    assert.equal(entry.resultCount, 10);
    assert.equal(entry.keyIndex, 0);
  });

  it("switches to next key on auth/quota failure and succeeds", async () => {
    let key1Calls = 0;
    const factory = makeFactory({
      key1: async () => {
        key1Calls += 1;
        throw Object.assign(new Error("auth failed"), { status: 401 });
      },
      key2: async () => ({
        results: [{ title: "ok", url: "https://example.com" }],
      }),
    });

    const res = await search(
      { query: "failover" },
      { config: resolveSearchConfig({ apiKeys: ["key1", "key2"], logPath: tmpLog }), clientFactory: factory },
    );

    assert.equal(key1Calls, 1);
    assert.equal(res.results.length, 1);
    const logLines = fs.readFileSync(tmpLog, "utf-8").trim().split("\n");
    assert.equal(logLines.length, 2);
    const first = JSON.parse(logLines[0]);
    const second = JSON.parse(logLines[1]);
    assert.equal(first.errorType, "auth");
    assert.equal(second.resultCount, 1);
  });

  it("does not retry on input error", async () => {
    let calls = 0;
    const factory = makeFactory({
      key1: async () => {
        calls += 1;
        const err = Object.assign(new Error("bad request"), { status: 400 });
        throw err;
      },
    });

    await assert.rejects(
      () =>
        search(
          { query: "bad" },
          { config: resolveSearchConfig({ apiKeys: ["key1"], logPath: tmpLog }), clientFactory: factory },
        ),
      (error: any) => {
        assert.equal(error.type, "input");
        return true;
      },
    );

    assert.equal(calls, 1);
  });
});
