import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerClient } from "../../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../../server/codex/appServer/daemonRegistry.js";
import {
  CodexAppServerAdapter,
  CODEX_APP_SERVER_ADAPTER_ID,
} from "../../../server/agents/adapters/codexAppServerAdapter.js";

interface RpcLine {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

interface FakeServer {
  client: CodexAppServerClient;
  stdin: PassThrough;
  stdout: PassThrough;
  /** Send a notification from the (fake) server to the client. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Drain queued client requests visible so far. */
  requests: RpcLine[];
}

function buildFakeServer(opts?: { autoReplies?: Record<string, (msg: RpcLine) => Record<string, unknown>> }): FakeServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr, waitClose: async () => null });

  const requests: RpcLine[] = [];
  const autoReplies = opts?.autoReplies ?? {};

  let buf = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcLine;
      requests.push(msg);
      if (msg.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
        continue;
      }
      const replier = msg.method ? autoReplies[msg.method] : undefined;
      if (replier) {
        const result = replier(msg);
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
      }
    }
  });

  const notify = (method: string, params: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  return { client, stdin, stdout, notify, requests };
}

describe("CodexAppServerAdapter", () => {
  it("uses the distinct adapter id 'codex-appserver'", () => {
    const adapter = new CodexAppServerAdapter({ projectId: "p" });
    assert.equal(adapter.id, CODEX_APP_SERVER_ADAPTER_ID);
    assert.equal(adapter.id, "codex-appserver");
  });

  it("creates a thread, sends a turn, and returns the assistant message", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-1" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "demo", registry });

    const events: string[] = [];
    adapter.onEvent((e) => events.push(`${e.phase}:${e.title}`));

    const sendPromise = adapter.send("hello world");

    // Wait briefly so the adapter wires up its notification handlers and the
    // fake server has processed initialize + thread/start + turn/start.
    await new Promise((r) => setTimeout(r, 30));

    fake.notify("thread/started", { thread: { id: "thread-1" } });
    fake.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.notify("item/started", {
      item: { type: "agentMessage", id: "m1", text: "" },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: Date.now(),
    });
    fake.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "m1",
      delta: "Hi ",
    });
    fake.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "m1",
      delta: "there!",
    });
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "Hi there!" },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: Date.now(),
    });
    fake.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", usage: { input_tokens: 5, output_tokens: 7 } },
      usage: { input_tokens: 5, output_tokens: 7 },
    });

    const result = await sendPromise;
    assert.equal(result.agentId, "codex-appserver");
    assert.equal(result.response, "Hi there!");
    assert.equal(adapter.getThreadId(), "thread-1");

    // Verify request shape sent to the daemon.
    const threadStartRequest = fake.requests.find((r) => r.method === "thread/start");
    assert(threadStartRequest, "expected thread/start request");
    const turnStartRequest = fake.requests.find((r) => r.method === "turn/start");
    assert(turnStartRequest, "expected turn/start request");
    assert.equal((turnStartRequest!.params as any).threadId, "thread-1");
    assert.equal((turnStartRequest!.params as any).input[0].type, "text");
    assert.equal((turnStartRequest!.params as any).input[0].text, "hello world");

    // Lifecycle events should include boot → analysis → responding → completed.
    assert(events.some((e) => e.startsWith("boot:")));
    assert(events.some((e) => e.startsWith("analysis:")));
    assert(events.some((e) => e.startsWith("responding:")));
    assert(events.some((e) => e.startsWith("completed:")));

    await registry.stopAll();
  });

  it("reuses an existing threadId on a subsequent send", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-1" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "reuse", registry });

    const firstSend = adapter.send("first");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/completed", { threadId: "thread-1", turn: { id: "t1" } });
    await firstSend;

    const startsBefore = fake.requests.filter((r) => r.method === "thread/start").length;
    const secondSend = adapter.send("second");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/completed", { threadId: "thread-1", turn: { id: "t2" } });
    await secondSend;

    const startsAfter = fake.requests.filter((r) => r.method === "thread/start").length;
    assert.equal(startsAfter, startsBefore, "thread/start must not be issued again");

    await registry.stopAll();
  });

  it("propagates server-side errors as a turn failure", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-err" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "err", registry });

    const sendPromise = adapter.send("explode please");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("error", {
      error: { message: "model unreachable" },
      willRetry: false,
      threadId: "t-err",
      turnId: "turn-err",
    });

    await assert.rejects(sendPromise, /model unreachable/);
    await registry.stopAll();
  });

  it("retries high-demand upstream errors with the same input", async () => {
    let turnStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-retry" } }),
        "turn/start": () => {
          turnStarts += 1;
          return {};
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "retry", registry });

    const sendPromise = adapter.send("retry me");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("error", {
      error: {
        message:
          "5 reconnect attempts failed: We're currently experiencing high demand, which may cause temporary errors",
      },
      threadId: "t-retry",
      turnId: "turn-1",
    });

    while (turnStarts < 2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "OK" },
      threadId: "t-retry",
      turnId: "turn-2",
      completedAtMs: Date.now(),
    });
    fake.notify("turn/completed", {
      threadId: "t-retry",
      turn: { id: "turn-2" },
    });

    const result = await sendPromise;
    assert.equal(result.response, "OK");
    assert.equal(turnStarts, 2);
    const turnStartRequests = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(turnStartRequests.length, 2);
    assert.deepEqual((turnStartRequests[0]!.params as any).input, (turnStartRequests[1]!.params as any).input);
    await registry.stopAll();
  });

  it("retries HTTP 429 errors with the same input", async () => {
    let turnStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-retry-429" } }),
        "turn/start": () => {
          turnStarts += 1;
          return {};
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "retry-429", registry });

    const sendPromise = adapter.send("retry 429");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("error", {
      error: { message: "API Error: Request rejected (429): Service unavailable" },
      threadId: "t-retry-429",
      turnId: "turn-1",
    });

    while (turnStarts < 2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "OK 429" },
      threadId: "t-retry-429",
      turnId: "turn-2",
      completedAtMs: Date.now(),
    });
    fake.notify("turn/completed", {
      threadId: "t-retry-429",
      turn: { id: "turn-2" },
    });

    const result = await sendPromise;
    assert.equal(result.response, "OK 429");
    assert.equal(turnStarts, 2);
    const turnStartRequests = fake.requests.filter((r) => r.method === "turn/start");
    assert.equal(turnStartRequests.length, 2);
    assert.deepEqual((turnStartRequests[0]!.params as any).input, (turnStartRequests[1]!.params as any).input);
    await registry.stopAll();
  });

  it("does not retry BYOK 500 capacity errors", async () => {
    let turnStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-byok" } }),
        "turn/start": () => {
          turnStarts += 1;
          return {};
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "byok", registry });

    const sendPromise = adapter.send("no retry");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("error", {
      error: {
        message:
          "BYOK Error: 500 当前模型 gpt-5.5 负载已经达到上限，请稍后重试\n\nUpstream error: 当前模型 gpt-5.5 负载已经达到上限，请稍后重试",
      },
      threadId: "t-byok",
      turnId: "turn-1",
    });

    await assert.rejects(sendPromise, /BYOK Error: 500/);
    assert.equal(turnStarts, 1);
    await registry.stopAll();
  });

  it("does not retry transient errors after side-effect items start", async () => {
    let turnStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-side-effect" } }),
        "turn/start": () => {
          turnStarts += 1;
          return {};
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "retry-side-effect", registry });

    const sendPromise = adapter.send("retry me");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("item/started", {
      item: { type: "commandExecution", id: "cmd-1", command: "date", status: "in_progress" },
      threadId: "t-side-effect",
      turnId: "turn-1",
    });
    fake.notify("error", {
      error: {
        message: "We're currently experiencing high demand, which may cause temporary errors",
      },
      threadId: "t-side-effect",
      turnId: "turn-1",
    });

    await assert.rejects(sendPromise, /high demand/);
    assert.equal(turnStarts, 1);
    await registry.stopAll();
  });

  it("rejects empty prompts", async () => {
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => buildFakeServer().client,
    });
    const adapter = new CodexAppServerAdapter({ projectId: "empty", registry });
    await assert.rejects(adapter.send(""), /Prompt 不能为空/);
    await registry.stopAll();
  });

  it("aborts an in-flight turn and sends turn/interrupt", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-abort" } }),
        "turn/start": () => ({}),
        "turn/interrupt": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "abort", registry });
    const controller = new AbortController();

    const sendPromise = adapter.send("hang", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/started", { threadId: "t-abort", turn: { id: "turn-abort" } });
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();
    await assert.rejects(sendPromise, (err: Error) => err.name === "AbortError");
    // Allow the interrupt fire-and-forget request to flush.
    await new Promise((r) => setTimeout(r, 20));
    assert(fake.requests.some((r) => r.method === "turn/interrupt"));

    await registry.stopAll();
  });
});
