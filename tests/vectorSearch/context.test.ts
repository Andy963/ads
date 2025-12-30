import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase } from "../../src/state/database.js";
import { maybeBuildVectorAutoContext } from "../../src/vectorSearch/context.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-vsearch-context-"));
  fs.mkdirSync(path.join(root, ".ads", "templates"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ads", "workspace.json"), JSON.stringify({ name: "test" }), "utf8");
  fs.writeFileSync(path.join(root, ".ads", "templates", "instructions.md"), "test", "utf8");
  return root;
}

describe("vectorSearch/auto-context", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

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
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS;
    originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS = process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS;

    setEnv("ADS_VECTOR_SEARCH_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_URL", "http://vector.local");
    setEnv("ADS_VECTOR_SEARCH_TOKEN", "test-token");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", "1");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", "60000");
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS", "");
  });

  afterEach(() => {
    setEnv("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
    setEnv("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS);
    setEnv("ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS);
    globalThis.fetch = originalFetch;
  });

  it("skips retrieval when query does not match trigger keywords", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[] = [];

    globalThis.fetch = async (url, _options) => {
      calls.push(String(url));
      return new Response("not expected", { status: 500 });
    };

    const context = await maybeBuildVectorAutoContext({ workspaceRoot, query: "how to implement auth?" });
    assert.equal(context, null);
    assert.equal(calls.length, 0);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("throttles retrieval and reuses cached context within the interval", async () => {
    const workspaceRoot = makeWorkspace();
    const calls: string[] = [];

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      calls.push(target);
      const method = String((options as any)?.method ?? "GET").toUpperCase();
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
      const method = String((options as any)?.method ?? "GET").toUpperCase();
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
    const db = getStateDatabase(path.join(workspaceRoot, ".ads", "state.db"));
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
      const method = String((options as any)?.method ?? "GET").toUpperCase();
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
        const body = JSON.parse(String((options as any)?.body ?? "{}")) as any;
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
