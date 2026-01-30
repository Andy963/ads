import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { maybeBuildVectorAutoContext, type VectorAutoContextReport } from "../../src/vectorSearch/context.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-vsearch-autocontext-"));
  const templatesDir = resolveWorkspaceStatePath(root, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(resolveWorkspaceStatePath(root, "workspace.json"), JSON.stringify({ name: "test" }), "utf8");
  fs.writeFileSync(resolveWorkspaceStatePath(root, "templates", "instructions.md"), "test", "utf8");
  return root;
}

describe("vectorSearch/autoContext report contract", () => {
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
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED;
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS;

    adsState = installTempAdsStateDir("ads-state-vsearch-autocontext-");
    workspaceRoot = makeWorkspace();

    setEnv("ADS_VECTOR_SEARCH_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_URL", "http://vector.local");
    setEnv("ADS_VECTOR_SEARCH_TOKEN", "test-token");
    setEnv("ADS_VECTOR_SEARCH_TIMEOUT_MS", "50");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", "0");
  });

  afterEach(() => {
    setEnv("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
    setEnv("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
    setEnv("ADS_VECTOR_SEARCH_TIMEOUT_MS", originalEnv.ADS_VECTOR_SEARCH_TIMEOUT_MS);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS);

    globalThis.fetch = originalFetch;

    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    workspaceRoot = null;

    adsState?.restore();
    adsState = null;
  });

  it("keeps report.message free of duplicated 'code/http/reason' fragments on HTTP failures", async () => {
    assert.ok(workspaceRoot);

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
        return new Response("query failed (400)", {
          status: 400,
          headers: { "content-type": "text/plain" },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const reports: VectorAutoContextReport[] = [];
    const context = await maybeBuildVectorAutoContext({
      workspaceRoot,
      query: "hello",
      historyNamespace: "test",
      historySessionId: "s-1",
      onReport: (report) => reports.push(report),
    });

    assert.equal(context, null);
    assert.ok(reports.length >= 1);
    const last = reports[reports.length - 1]!;

    assert.equal(last.attempted, true);
    assert.equal(last.ok, false);
    assert.equal(last.code, "query_failed");
    assert.equal(last.httpStatus, 400);

    // The UI summary already has structured fields (code/http/provider).
    // Keeping report.message as the raw provider error prevents duplicated strings like:
    // "code=query_failed http=400 reason=query_failed http=400 reason=query failed (400)".
    assert.equal(last.message, "query failed (400)");
  });
});

