import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createCfMemClient,
  normalizeCfMemUrl,
} from "../../server/middleware/builtin/cfMemClient.js";
import { createCoreMiddlewarePipeline } from "../../server/middleware/index.js";
import type { TurnContext } from "../../server/middleware/types.js";

async function withGitWorkspace<T>(fn: (workspaceRoot: string) => T | Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cfmem-client-test-"));
  const workspaceRoot = path.join(root, "ads");
  fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
  try {
    return await fn(workspaceRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createContext(workspaceRoot: string): TurnContext {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceRoot,
    channel: "web",
    prompt: "<recalled_memory>synthetic context</recalled_memory>\n\noriginal prompt",
    originalPrompt: "original prompt",
    metadata: {
      authUserId: "server-user",
      userId: "client-user",
    },
  };
}

describe("cf-mem client", () => {
  it("normalizes memory API URLs without duplicating the memory path", () => {
    assert.equal(normalizeCfMemUrl("https://memory.example.test"), "https://memory.example.test/memory");
    assert.equal(normalizeCfMemUrl("https://memory.example.test/memory/"), "https://memory.example.test/memory");
    assert.equal(normalizeCfMemUrl("https://memory.example.test/api/memory"), "https://memory.example.test/api/memory");
    assert.equal(normalizeCfMemUrl("not a URL"), null);
    assert.equal(normalizeCfMemUrl("https://user:secret@memory.example.test"), null);
  });

  it("sends bounded recall requests with server identity and project scope", async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const client = createCfMemClient({
        apiBase: "https://memory.example.test/memory/",
        apiKey: "test-secret",
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init });
          return new Response(JSON.stringify({
            claims: [
              { canonical_text: "Use the repository's stable migration pattern.", secret: "must not be copied" },
              { value: { raw: "object data" } },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });

      const recalled = await client.recall(createContext(workspaceRoot));
      assert.equal(recalled, "- Use the repository's stable migration pattern.");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "https://memory.example.test/memory/context");
      assert.equal(requests[0]?.init.headers && new Headers(requests[0].init.headers).get("Authorization"), "Bearer test-secret");
      assert.equal(requests[0]?.init.headers && new Headers(requests[0].init.headers).get("X-Project-Id"), "ads");

      const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
      assert.equal(body.user_id, "server-user");
      assert.equal(body.query, "original prompt");
      assert.equal(body.workspace_id && String(body.workspace_id).startsWith("ws_ads_"), true);
      assert.equal(body.limit, 5);
      assert.equal(JSON.stringify(body).includes("client-user"), false);
    });
  });

  it("ingests only the original prompt and cleaned final response with deterministic event ids", async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const requests: Array<{ init: RequestInit }> = [];
      const client = createCfMemClient({
        apiBase: "https://memory.example.test/memory",
        apiKey: "test-secret",
        fetchImpl: async (_url, init) => {
          requests.push({ init });
          return new Response(JSON.stringify({ ok: true }), { status: 202 });
        },
      });
      const ctx = createContext(workspaceRoot);

      await client.ingest(ctx, "<recalled_memory source=\"cf-mem\">do not store</recalled_memory><thought id=\"hidden\">private reasoning</thought>Final answer\n<<<tool.memory.update>>>secret trace>>>");
      const firstBodies = requests.map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
      assert.deepEqual(firstBodies.map((body) => body.role), ["user", "assistant"]);
      assert.equal(firstBodies[0]?.text, "original prompt");
      assert.equal(firstBodies[1]?.text, "Final answer");
      assert.equal(firstBodies[0]?.source_app, "codex");
      assert.equal(firstBodies[0]?.external_session_id, "session-1");
      assert.equal(firstBodies[0]?.workspace_name, "ads");
      assert.equal(new Headers(requests[0]?.init.headers).get("X-Project-Id"), "ads");

      await client.ingest(ctx, "Final answer");
      const secondBodies = requests.slice(2).map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
      assert.equal(firstBodies[0]?.event_id, secondBodies[0]?.event_id);
      assert.equal(firstBodies[1]?.event_id, secondBodies[1]?.event_id);
      assert.notEqual(firstBodies[0]?.event_id, firstBodies[1]?.event_id);
    });
  });

  it("fails open for HTTP failures and missing server scope", async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const client = createCfMemClient({
        apiBase: "https://memory.example.test",
        apiKey: "test-secret",
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      });
      assert.equal(await client.recall(createContext(workspaceRoot)), null);

      const noIdentity = createContext(workspaceRoot);
      noIdentity.metadata = { userId: "client-only" };
      assert.equal(await client.recall(noIdentity), null);
    });
  });

  it("automatically enables cf-mem only when both environment values are present", () => {
    const savedUrl = process.env.CFMEM_URL;
    const savedKey = process.env.CFMEM_API_KEY;
    try {
      process.env.CFMEM_URL = "https://memory.example.test";
      process.env.CFMEM_API_KEY = "test-secret";
      const enabled = createCoreMiddlewarePipeline({ includeGlobalRules: false, includeContextArtifact: false });
      assert.deepEqual(enabled.getMiddlewares().map((middleware) => middleware.name), ["cfMem"]);

      delete process.env.CFMEM_API_KEY;
      const partial = createCoreMiddlewarePipeline({ includeGlobalRules: false, includeContextArtifact: false });
      assert.deepEqual(partial.getMiddlewares().map((middleware) => middleware.name), []);
    } finally {
      if (savedUrl === undefined) delete process.env.CFMEM_URL;
      else process.env.CFMEM_URL = savedUrl;
      if (savedKey === undefined) delete process.env.CFMEM_API_KEY;
      else process.env.CFMEM_API_KEY = savedKey;
    }
  });
});
