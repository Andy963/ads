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

  it("maps native collab tool calls to subagent events with a stable tool_use id", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-collab" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "demo", registry });

    const subagentEvents: Array<{ title: string; detail?: string; itemId?: string; status?: string }> = [];
    adapter.onEvent((e) => {
      if (e.phase !== "subagent") return;
      const rawItem = (e.raw as { item?: { id?: string; status?: string } } | undefined)?.item;
      subagentEvents.push({ title: e.title, detail: e.detail, itemId: rawItem?.id, status: rawItem?.status });
    });

    const sendPromise = adapter.send("spawn a helper");
    await new Promise((r) => setTimeout(r, 30));

    fake.notify("thread/started", { thread: { id: "thread-collab" } });
    fake.notify("turn/started", { threadId: "thread-collab", turn: { id: "turn-1" } });
    // Daemon spawns a collab agent: started → completed with terminal states.
    fake.notify("item/started", {
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["child-thread-9"],
        prompt: "review the diff",
        agentsStates: {},
      },
      threadId: "thread-collab",
      turnId: "turn-1",
    });
    fake.notify("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["child-thread-9"],
        prompt: "review the diff",
        agentsStates: { "child-thread-9": { status: "completed", message: "done: no issues" } },
      },
      threadId: "thread-collab",
      turnId: "turn-1",
    });
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "ok" },
      threadId: "thread-collab",
      turnId: "turn-1",
    });
    fake.notify("turn/completed", { threadId: "thread-collab", turn: { id: "turn-1" } });

    const result = await sendPromise;
    assert.equal(result.response, "ok");

    // started + completed both surfaced, sharing the collab item id so the web
    // delegation view can correlate them.
    assert.equal(subagentEvents.length, 2);
    assert.equal(subagentEvents[0]?.title, "调度子代理");
    assert.equal(subagentEvents[1]?.title, "子代理完成");
    assert.equal(subagentEvents[0]?.itemId, "collab-1");
    assert.equal(subagentEvents[1]?.itemId, "collab-1");
    assert.match(subagentEvents[0]?.detail ?? "", /spawnAgent → child-thread-9/);

    await registry.stopAll();
  });

  it("marks collab dispatch failed when an agent state reports errored", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-collab-err" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "demo", registry });

    const statuses: Array<string | undefined> = [];
    adapter.onEvent((e) => {
      if (e.phase !== "subagent") return;
      const rawItem = (e.raw as { item?: { status?: string } } | undefined)?.item;
      statuses.push(rawItem?.status);
    });

    const sendPromise = adapter.send("spawn a failing helper");
    await new Promise((r) => setTimeout(r, 30));

    fake.notify("thread/started", { thread: { id: "thread-collab-err" } });
    fake.notify("turn/started", { threadId: "thread-collab-err", turn: { id: "turn-1" } });
    fake.notify("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "collab-err",
        tool: "wait",
        status: "completed",
        receiverThreadIds: ["child-a"],
        prompt: "",
        agentsStates: { "child-a": { status: "errored", message: "boom" } },
      },
      threadId: "thread-collab-err",
      turnId: "turn-1",
    });
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "done" },
      threadId: "thread-collab-err",
      turnId: "turn-1",
    });
    fake.notify("turn/completed", { threadId: "thread-collab-err", turn: { id: "turn-1" } });

    await sendPromise;
    // An errored child flips the dispatch item status to failed.
    assert.deepEqual(statuses, ["failed"]);

    await registry.stopAll();
  });

  it("announces subagents still running in the daemon when the turn completes", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-collab-bg" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "demo", registry });

    const subagentTitles: string[] = [];
    adapter.onEvent((e) => {
      if (e.phase === "subagent") subagentTitles.push(`${e.title}|${e.detail ?? ""}`);
    });

    const sendPromise = adapter.send("spawn a background helper");
    await new Promise((r) => setTimeout(r, 30));

    fake.notify("thread/started", { thread: { id: "thread-collab-bg" } });
    fake.notify("turn/started", { threadId: "thread-collab-bg", turn: { id: "turn-1" } });
    // spawnAgent completes as a tool call, but the spawned thread keeps running
    // (no terminal state reported for child-bg before the turn ends).
    fake.notify("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "collab-bg",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["child-bg"],
        prompt: "long background task",
        agentsStates: { "child-bg": { status: "running" } },
      },
      threadId: "thread-collab-bg",
      turnId: "turn-1",
    });
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "kicked off" },
      threadId: "thread-collab-bg",
      turnId: "turn-1",
    });
    fake.notify("turn/completed", { threadId: "thread-collab-bg", turn: { id: "turn-1" } });

    const result = await sendPromise;
    assert.equal(result.response, "kicked off");
    assert(
      subagentTitles.some((t) => t.startsWith("子代理仍在后台运行|") && t.includes("1 个")),
      `expected still-running notice, got: ${JSON.stringify(subagentTitles)}`,
    );

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

  it("keeps the turn alive while the app-server reconnects its response stream", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-reconnect" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "reconnect", registry });
    const events: Array<{ phase: string; title: string; detail?: string }> = [];
    adapter.onEvent((event) => {
      events.push({ phase: event.phase, title: event.title, detail: event.detail });
    });

    const sendPromise = adapter.send("wait for reconnect");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.notify("error", {
      error: {
        message:
          "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)",
      },
      willRetry: true,
      threadId: "t-reconnect",
      turnId: "turn-reconnect",
    });
    fake.notify("error", {
      error: { message: "Temporary upstream transport failure" },
      willRetry: true,
      threadId: "t-reconnect",
      turnId: "turn-reconnect",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "Recovered" },
      threadId: "t-reconnect",
      turnId: "turn-reconnect",
    });
    fake.notify("turn/completed", {
      threadId: "t-reconnect",
      turn: { id: "turn-reconnect" },
    });

    const result = await sendPromise;
    assert.equal(result.response, "Recovered");
    assert(
      events.some(
        (event) =>
          event.phase === "connection" &&
          event.title === "尝试重连" &&
          event.detail === "1/5",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.phase === "connection" &&
          event.title === "尝试重连" &&
          event.detail === "Temporary upstream transport failure",
      ),
    );
    assert(!events.some((event) => event.phase === "error"));
    await registry.stopAll();
  });

  it("fails a terminal error even when its message resembles a reconnect notice", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-terminal-reconnect" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "terminal-reconnect", registry });

    const sendPromise = adapter.send("fail without retry");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.notify("error", {
      error: { message: "Reconnecting... 5/5 failed permanently" },
      willRetry: false,
      threadId: "t-terminal-reconnect",
      turnId: "turn-terminal-reconnect",
    });

    await assert.rejects(sendPromise, /failed permanently/);
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
