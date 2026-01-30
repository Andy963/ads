import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { queryVectorSearchHits } from "../../src/vectorSearch/run.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-vsearch-run-"));
  const templatesDir = resolveWorkspaceStatePath(root, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(resolveWorkspaceStatePath(root, "workspace.json"), JSON.stringify({ name: "test" }), "utf8");
  fs.writeFileSync(resolveWorkspaceStatePath(root, "templates", "instructions.md"), "test", "utf8");
  return root;
}

describe("vectorSearch/run bucketing + retry", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let workspaceRoot: string | null = null;
  let adsState: TempAdsStateDir | null = null;

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    originalEnv.ADS_VECTOR_SEARCH_ENABLED = process.env.ADS_VECTOR_SEARCH_ENABLED;
    originalEnv.ADS_VECTOR_SEARCH_URL = process.env.ADS_VECTOR_SEARCH_URL;
    originalEnv.ADS_VECTOR_SEARCH_TOKEN = process.env.ADS_VECTOR_SEARCH_TOKEN;
    originalEnv.ADS_VECTOR_SEARCH_TIMEOUT_MS = process.env.ADS_VECTOR_SEARCH_TIMEOUT_MS;

    adsState = installTempAdsStateDir("ads-state-vsearch-run-");
    workspaceRoot = makeWorkspace();

    setEnv("ADS_VECTOR_SEARCH_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_URL", "http://vector.local");
    setEnv("ADS_VECTOR_SEARCH_TOKEN", "test-token");
    setEnv("ADS_VECTOR_SEARCH_TIMEOUT_MS", "50");
  });

  afterEach(() => {
    setEnv("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
    setEnv("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
    setEnv("ADS_VECTOR_SEARCH_TIMEOUT_MS", originalEnv.ADS_VECTOR_SEARCH_TIMEOUT_MS);

    globalThis.fetch = originalFetch;

    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    workspaceRoot = null;

    adsState?.restore();
    adsState = null;
  });

  it("retries a transient health failure once", async () => {
    assert.ok(workspaceRoot);
    let healthCalls = 0;
    let queryCalls = 0;

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      const request = (options ?? {}) as RequestInit;
      const method = String(request.method ?? "GET").toUpperCase();
      const pathname = new URL(target).pathname;

      if (pathname === "/health" && method === "GET") {
        healthCalls += 1;
        if (healthCalls === 1) {
          return new Response(JSON.stringify({ code: "overloaded", message: "overloaded" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/upsert" && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/query" && method === "POST") {
        queryCalls += 1;
        return new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await queryVectorSearchHits({ workspaceRoot, query: "hello" });
    assert.equal(result.ok, true);
    assert.equal(healthCalls, 2);
    assert.equal(queryCalls, 1);
    assert.equal(result.retryCount, 1);
  });

  it("retries a transient query timeout once", async () => {
    assert.ok(workspaceRoot);
    let queryCalls = 0;

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      const request = (options ?? {}) as RequestInit;
      const method = String(request.method ?? "GET").toUpperCase();
      const pathname = new URL(target).pathname;

      if (pathname === "/health" && method === "GET") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/upsert" && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/query" && method === "POST") {
        queryCalls += 1;
        if (queryCalls === 1) {
          const err = new Error("aborted");
          (err as unknown as { name?: string }).name = "AbortError";
          throw err;
        }
        return new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await queryVectorSearchHits({ workspaceRoot, query: "hello" });
    assert.equal(result.ok, true);
    assert.equal(queryCalls, 2);
    assert.ok((result.retryCount ?? 0) >= 1);
  });

  it("classifies disabled config as a non-network failure with a reason", async () => {
    assert.ok(workspaceRoot);
    setEnv("ADS_VECTOR_SEARCH_ENABLED", "0");

    const result = await queryVectorSearchHits({ workspaceRoot, query: "hello" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "disabled");
    assert.ok(String(result.message ?? "").includes("disabled"));
    assert.equal(result.retryCount, 0);
  });
});

