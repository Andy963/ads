import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase } from "../../src/state/database.js";
import { maybeBuildVectorAutoContext } from "../../src/vectorSearch/context.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-vsearch-context-"));
  const templatesDir = resolveWorkspaceStatePath(root, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(resolveWorkspaceStatePath(root, "workspace.json"), JSON.stringify({ name: "test" }), "utf8");
  fs.writeFileSync(resolveWorkspaceStatePath(root, "templates", "instructions.md"), "test", "utf8");
  return root;
}

describe("vectorSearch/auto-context", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
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
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED;
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE;
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS;
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS;
    adsState = installTempAdsStateDir("ads-state-vsearch-context-");

    setEnv("ADS_VECTOR_SEARCH_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_URL", "http://vector.local");
    setEnv("ADS_VECTOR_SEARCH_TOKEN", "test-token");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", "always");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", "60000");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS", "");
  });

  afterEach(() => {
    setEnv("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
    setEnv("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS);
    globalThis.fetch = originalFetch;
    adsState?.restore();
    adsState = null;
  });

  it("retrieves context even when query is not a trigger keyword", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[] = [];

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      calls.push(target);
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
        return new Response(
          JSON.stringify({
            hits: [
              {
                id: "hit-1",
                score: 0.9,
                metadata: { source_type: "spec", path: "docs/spec/x/requirements.md" },
                snippet: "Auth requirements (example)",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const context = await maybeBuildVectorAutoContext({ workspaceRoot, query: "how to implement auth?" });
    assert.ok(context);
    assert.ok(calls.some((call) => call.endsWith("/query")));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("throttles retrieval and reuses cached context within the interval", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[] = [];

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      calls.push(target);
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
        return new Response(
          JSON.stringify({
            hits: [
              {
                id: "hit-1",
                score: 0.9,
                metadata: { source_type: "spec", path: "docs/spec/x/requirements.md" },
                snippet: "Auth requirements (example)",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const first = await maybeBuildVectorAutoContext({ workspaceRoot, query: "继续" });
    assert.ok(first);
    const firstCalls = calls.length;
    assert.ok(firstCalls > 0);

    const second = await maybeBuildVectorAutoContext({ workspaceRoot, query: "继续" });
    assert.equal(second, first);
    assert.equal(calls.length, firstCalls);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("reranks retrieved hits before formatting context", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[] = [];

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      calls.push(target);
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
        return new Response(
          JSON.stringify({
            hits: [
              {
                id: "hit-1",
                score: 0.95,
                metadata: { source_type: "spec", path: "docs/spec/x/requirements.md" },
                snippet: "First snippet",
              },
              {
                id: "hit-2",
                score: 0.9,
                metadata: { source_type: "spec", path: "docs/spec/y/requirements.md" },
                snippet: "Second snippet",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (pathname === "/rerank" && method === "POST") {
        return new Response(
          JSON.stringify({
            hits: [
              { id: "hit-2", rerank_score: 0.99 },
              { id: "hit-1", rerank_score: 0.12 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const context = await maybeBuildVectorAutoContext({ workspaceRoot, query: "继续" });
    assert.ok(context);
    assert.ok(calls.some((call) => call.endsWith("/rerank")));
    assert.ok(context.indexOf("Second snippet") < context.indexOf("First snippet"));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("derives a better query from recent history when the input is only a trigger word", async () => {
    const workspaceRoot = makeWorkspace();
    const db = getStateDatabase(resolveWorkspaceStatePath(workspaceRoot, "state.db"));
    const now = Date.now();
    db.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("cli", "default", "user", "请继续实现 rerank 功能", now - 10_000, null);
    db.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("cli", "default", "ai", "OK, implementing rerank next.", now - 9_000, null);
    db.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("cli", "default", "user", "继续", now - 8_000, null);

    let capturedQuery: string | null = null;

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
        const bodyText = typeof request.body === "string" ? request.body : "";
        const body = JSON.parse(bodyText || "{}") as Record<string, unknown>;
        capturedQuery = String(body.query ?? "");
        return new Response(
          JSON.stringify({
            hits: [
              {
                id: "hit-1",
                score: 0.9,
                metadata: { source_type: "spec", path: "docs/spec/x/requirements.md" },
                snippet: "Example snippet",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const context = await maybeBuildVectorAutoContext({
      workspaceRoot,
      query: "继续",
      historyNamespace: "cli",
      historySessionId: "default",
    });

    assert.ok(context);
    assert.equal(capturedQuery, "请继续实现 rerank 功能");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
