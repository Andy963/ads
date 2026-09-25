import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { resolveTransientModelRetryMaxAttempts } from "../../server/agents/adapters/transientModelRetry.js";
import { completeNativeChat, NativeProviderError } from "../../server/runtime/openAiCompatibleClient.js";
import type { NativeModelResolver } from "../../server/runtime/modelResolver.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

function sse(events: string[]): Response {
  return new Response(`${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function resolver(): NativeModelResolver {
  return {
    resolve: () => ({
      model: "test-model",
      baseUrl: "https://provider.test/v1",
      apiKey: "test-api-key",
      provider: "test",
    }),
  };
}

describe("Native provider retry and recovery", () => {
  it("retries a transient provider response and publishes a retry event", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-"));
    try {
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [0],
        fetchImpl: async () => {
          requests += 1;
          if (requests === 1) return new Response("temporarily unavailable", { status: 503 });
          return sse([JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })]);
        },
      });
      const retries: Array<{ retryCount: number; maxAttempts: number }> = [];
      adapter.onEvent((event) => {
        if (event.retry) retries.push({ retryCount: event.retry.retryCount, maxAttempts: event.retry.maxAttempts });
      });

      const result = await adapter.send("retry me");

      assert.equal(result.response, "recovered");
      assert.equal(requests, 2);
      assert.deepEqual(retries, [{ retryCount: 1, maxAttempts: resolveTransientModelRetryMaxAttempts() }]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not retry permanent provider failures", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-no-retry-"));
    try {
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [0],
        fetchImpl: async () => {
          requests += 1;
          return new Response("fetch failed: HTTP 503 secret-response-body", { status: 401 });
        },
      });

      await assert.rejects(adapter.send("do not retry"), (error: unknown) => {
        assert.ok(error instanceof NativeProviderError);
        assert.equal(error.kind, "permanent");
        assert.equal(error.status, 401);
        return true;
      });
      assert.equal(requests, 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps protocol and unsupported 5xx responses terminal", async () => {
    for (const status of [501, 505, 525, 526, 527]) {
      await assert.rejects(
        completeNativeChat({
          baseUrl: "https://provider.test/v1",
          apiKey: "test-key",
          model: "test-model",
          messages: [],
          tools: [],
          fetchImpl: async () => new Response("permanent protocol failure", { status }),
        }),
        (error: unknown) => error instanceof NativeProviderError && error.kind === "permanent" && error.status === status,
      );
    }
  });

  it("cancels a retry backoff without starting another provider request", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-cancel-"));
    try {
      const controller = new AbortController();
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [100],
        fetchImpl: async () => {
          requests += 1;
          return new Response("temporary", { status: 503 });
        },
      });
      adapter.onEvent((event) => {
        if (event.retry) controller.abort();
      });

      await assert.rejects(
        adapter.send("cancel retry", { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(requests, 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("shares one turn timeout across retry backoff", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-timeout-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-timeout-db-"));
    const store = new NativeTranscriptStore(getStateDatabase(path.join(stateDir, "state.db")));
    try {
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [100],
        turnTimeoutMs: 20,
        transcriptId: "retry-timeout",
        transcriptStore: store,
        fetchImpl: async () => {
          requests += 1;
          return new Response("temporary", { status: 503 });
        },
      });

      await assert.rejects(
        adapter.send("timeout across retries"),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(requests, 1);
      assert.equal(store.listTurns("retry-timeout")[0]?.status, "interrupted");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves a retry checkpoint while another send waits for the lock", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-queue-race-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-queue-race-db-"));
    const store = new NativeTranscriptStore(getStateDatabase(path.join(stateDir, "state.db")));
    try {
      const controller = new AbortController();
      let requests = 0;
      let queuedSend: Promise<unknown> | undefined;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [100],
        transcriptId: "retry-queue-race",
        transcriptStore: store,
        fetchImpl: async () => {
          requests += 1;
          return requests === 1
            ? new Response("temporary", { status: 503 })
            : sse([JSON.stringify({ choices: [{ delta: { content: "second completed" }, finish_reason: "stop" }] })]);
        },
      });
      adapter.onEvent((event) => {
        if (event.retry && !queuedSend) {
          queuedSend = adapter.send("second turn");
          controller.abort();
        }
      });

      const firstSend = adapter.send("first turn", { signal: controller.signal });
      await assert.rejects(
        firstSend,
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.ok(queuedSend);
      const secondResult = await queuedSend;
      assert.equal(secondResult.response, "second completed");
      assert.equal(store.listTurns("retry-queue-race")[0]?.status, "cancelled");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not restore a turn cancelled during retry backoff", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-cancel-state-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-cancel-db-"));
    const store = new NativeTranscriptStore(getStateDatabase(path.join(stateDir, "state.db")));
    try {
      const controller = new AbortController();
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [100],
        transcriptId: "retry-cancel",
        transcriptStore: store,
        fetchImpl: async () => new Response("temporary", { status: 503 }),
      });
      adapter.onEvent((event) => {
        if (event.retry) controller.abort();
      });

      await assert.rejects(adapter.send("cancel persisted retry", { signal: controller.signal }));
      assert.equal(store.listTurns("retry-cancel")[0]?.status, "cancelled");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("finalizes a turn when cancellation races with a transient provider failure", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-cancel-race-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-cancel-race-db-"));
    const store = new NativeTranscriptStore(getStateDatabase(path.join(stateDir, "state.db")));
    try {
      const controller = new AbortController();
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [0],
        transcriptId: "retry-cancel-race",
        transcriptStore: store,
        fetchImpl: async () => {
          requests += 1;
          controller.abort();
          return new Response("temporary", { status: 503 });
        },
      });

      await assert.rejects(
        adapter.send("cancel during provider failure", { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(requests, 1);
      assert.equal(store.listTurns("retry-cancel-race")[0]?.status, "cancelled");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not replay a tool side effect when a later provider request fails", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-side-effect-"));
    try {
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [0],
        fetchImpl: async () => {
          requests += 1;
          if (requests === 1) {
            return sse([JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "read-1", function: { name: "read_file", arguments: "{\"file\":\"missing.txt\"}" } }] }, finish_reason: "tool_calls" }] })]);
          }
          return new Response("upstream failed", { status: 503 });
        },
        env: { ADS_TEST_NOOP: "1" },
      });
      await assert.rejects(adapter.send("run once"), (error: unknown) => error instanceof NativeProviderError);
      assert.equal(requests, 2);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a retried logical turn as one completed transcript turn", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-transcript-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-retry-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    try {
      let requests = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: resolver(),
        retryBackoffMs: [0],
        transcriptId: "retry-transcript",
        transcriptStore: store,
        fetchImpl: async () => {
          requests += 1;
          if (requests === 1) return new Response("temporary", { status: 503 });
          return sse([JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })]);
        },
      });

      await adapter.send("persist this");
      const turns = store.listTurns("retry-transcript");
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.status, "completed");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("classifies malformed and incomplete streams as non-retryable provider errors", async () => {
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        }),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response("data: {not-json}\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof NativeProviderError);
        assert.equal(error.kind, "malformed");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call-1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        streaming: false,
        fetchImpl: async () => new Response(JSON.stringify({
          choices: [{ message: { content: "done", tool_calls: {} }, finish_reason: "stop" }],
        }), { headers: { "content-type": "application/json" } }),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        streaming: false,
        fetchImpl: async () => new Response(JSON.stringify({
          choices: [{ message: { content: "done" } }],
        }), { headers: { "content-type": "application/json" } }),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"function\",\"id\":\"late-call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"custom\",\"id\":\"call-1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        streaming: false,
        fetchImpl: async () => ({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => {
            throw new DOMException("Aborted", "AbortError");
          },
        }) as Response,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        streaming: false,
        fetchImpl: async () => new Response(JSON.stringify({
          choices: [{ message: { content: "legacy", function_call: { name: "read_file", arguments: "{}" } }, finish_reason: "function_call" }],
        }), { headers: { "content-type": "application/json" } }),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"function_call\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages: [],
        tools: [],
        fetchImpl: async () => new Response(
          "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"mystery\"}]}\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      }),
      (error: unknown) => error instanceof NativeProviderError && error.kind === "malformed",
    );
  });
});
