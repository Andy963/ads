import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerClient } from "../../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../../server/codex/appServer/daemonRegistry.js";
import {
  CodexAppServerAdapter,
  CODEX_ADAPTER_ID,
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

function buildFakeServer(opts?: {
  autoReplies?: Record<string, (msg: RpcLine) => Record<string, unknown>>;
  autoErrors?: Record<string, (msg: RpcLine) => { code: number; message: string } | undefined>;
}): FakeServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr, waitClose: async () => null });

  const requests: RpcLine[] = [];
  const autoReplies = opts?.autoReplies ?? {};
  const autoErrors = opts?.autoErrors ?? {};

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
     if (msg.method === "thread/resume" && !autoReplies["thread/resume"] && !autoErrors["thread/resume"]) {
       stdout.write(
         `${JSON.stringify({
           jsonrpc: "2.0",
           id: msg.id,
           result: { thread: { id: msg.params?.threadId ?? "thread-resumed" } },
         })}\n`,
       );
       continue;
     }
     const replier = msg.method ? autoReplies[msg.method] : undefined;
      const error = msg.method ? autoErrors[msg.method]?.(msg) : undefined;
      if (error) {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error })}\n`);
        continue;
      }
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

async function waitForRequestCount(
  fake: FakeServer,
  method: string,
  count: number,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fake.requests.filter((request) => request.method === method).length < count) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${count} ${method} request(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CodexAppServerAdapter", () => {
  it("uses the unified codex adapter id", () => {
    const adapter = new CodexAppServerAdapter({ projectId: "p" });
    assert.equal(adapter.id, CODEX_ADAPTER_ID);
    assert.equal(adapter.id, "codex");
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
    assert.equal(result.agentId, "codex");
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

  it("bridges structured turn plan updates as todo_list events", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-plan" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "plan-events", registry });
    const rawEvents: unknown[] = [];
    adapter.onEvent((event) => rawEvents.push(event.raw));

    const sendPromise = adapter.send("execute the plan");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("turn/started", { threadId: "thread-plan", turn: { id: "turn-plan" } });
    fake.notify("turn/plan/updated", {
      threadId: "thread-plan",
      turnId: "turn-plan",
      explanation: null,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ],
    });
    fake.notify("turn/completed", { threadId: "thread-plan", turn: { id: "turn-plan" } });
    await sendPromise;

    const planEvent = rawEvents.find((event) => {
      const raw = event as { type?: unknown; item?: { type?: unknown } };
      return raw.type === "item.updated" && raw.item?.type === "todo_list";
    }) as { item?: { items?: Array<{ text: string; status: string }> } } | undefined;
    assert.deepEqual(planEvent?.item?.items, [
      { text: "Inspect", status: "completed" },
      { text: "Implement", status: "in_progress" },
      { text: "Verify", status: "pending" },
    ]);

    await registry.stopAll();
  });

  it("bridges v2 plan, reasoning summary, and compaction notifications", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-v2-events" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "v2-events", registry });
    const events: Array<{ phase: string; title: string; detail?: string }> = [];
    adapter.onEvent((event) => events.push({ phase: event.phase, title: event.title, detail: event.detail }));

    const sendPromise = adapter.send("exercise v2 events");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("turn/started", { threadId: "thread-v2-events", turn: { id: "turn-v2" } });
    fake.notify("item/plan/delta", {
      threadId: "thread-v2-events",
      turnId: "turn-v2",
      itemId: "plan-v2",
      delta: "Inspect the workspace",
    });
    fake.notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-v2-events",
      turnId: "turn-v2",
      itemId: "reasoning-v2",
      summaryIndex: 0,
      delta: "Comparing the existing adapters",
    });
    fake.notify("thread/compacted", { threadId: "thread-v2-events", turnId: "turn-v2" });
    fake.notify("turn/completed", { threadId: "thread-v2-events", turn: { id: "turn-v2" } });
    await sendPromise;

    assert(events.some((event) => event.phase === "plan" && event.detail === "Inspect the workspace"));
    assert(
      events.some(
        (event) => event.phase === "analysis" && event.title === "Reasoning summary" && event.detail === "Comparing the existing adapters",
      ),
    );
    assert(events.some((event) => event.phase === "context" && event.title === "Context ready"));

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

  it("resumes an existing persisted thread via thread/resume before turn start", async () => {
    let resumeCalls = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/resume": (msg) => {
          resumeCalls += 1;
          return { thread: { id: msg.params?.threadId } };
        },
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({
      projectId: "resume-thread-test",
      resumeThreadId: "thread-persisted-abc",
      registry,
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

    const sendPromise = adapter.send("hello from resumed thread");
    await waitForRequestCount(fake, "thread/resume", 1);
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m-resumed", text: "Welcome back" },
      threadId: "thread-persisted-abc",
      turnId: "turn-resumed",
    });
    fake.notify("turn/completed", { threadId: "thread-persisted-abc", turn: { id: "turn-resumed" } });

    const result = await sendPromise;
    assert.equal(result.response, "Welcome back");
    assert.equal(adapter.getThreadId(), "thread-persisted-abc");
    assert.equal(resumeCalls, 1);
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 0);
    assert.equal(
      (fake.requests.find((request) => request.method === "turn/start")?.params as any)?.threadId,
      "thread-persisted-abc",
    );
    const hasFallback = events.some(
      (event) => typeof event === "object" && event !== null && "sessionFallback" in event,
    );
    assert.equal(hasFallback, false, "must not emit sessionFallback on successful resume");

    // On second send, thread is already loaded in client, must not call thread/resume again
    const secondSendPromise = adapter.send("second message");
    await waitForRequestCount(fake, "turn/start", 2);
    assert.equal(fake.requests.filter((request) => request.method === "thread/resume").length, 1);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m-second", text: "Second reply" },
      threadId: "thread-persisted-abc",
      turnId: "turn-second",
    });
    fake.notify("turn/completed", { threadId: "thread-persisted-abc", turn: { id: "turn-second" } });
    await secondSendPromise;

    await registry.stopAll();
  });

  it("recreates a missing thread when thread/resume reports no rollout found", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-new-from-missing" } }),
        "turn/start": () => ({}),
      },
      autoErrors: {
        "thread/resume": () => ({
          code: -32600,
          message: "thread/resume: thread/resume failed: no rollout found for thread id thread-deleted",
        }),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({
      projectId: "missing-on-resume",
      resumeThreadId: "thread-deleted",
      registry,
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

    const sendPromise = adapter.send("recover from deleted thread");
    await waitForRequestCount(fake, "thread/resume", 1);
    await waitForRequestCount(fake, "thread/start", 1);
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m-recovered", text: "Recovered" },
      threadId: "thread-new-from-missing",
      turnId: "turn-recovered",
    });
    fake.notify("turn/completed", {
      threadId: "thread-new-from-missing",
      turn: { id: "turn-recovered" },
    });

    const result = await sendPromise;
    assert.equal(result.response, "Recovered");
    assert.equal(adapter.getThreadId(), "thread-new-from-missing");
    const fallbackEvent = events.find(
      (event): event is { sessionFallback?: unknown } =>
        typeof event === "object" && event !== null && "sessionFallback" in event,
    );
    assert(fallbackEvent, "expected a session fallback event");
    assert.deepEqual(fallbackEvent.sessionFallback, {
      reason: "missing_provider_session",
      previousSessionId: "thread-deleted",
    });

    await registry.stopAll();
  });

  it("recreates a missing resumed thread and retries the turn", async () => {
    let turnStartAttempts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-recreated" } }),
        "turn/start": () => ({}),
      },
      autoErrors: {
        "turn/start": () => {
          turnStartAttempts += 1;
          return turnStartAttempts === 1
            ? { code: -32600, message: "thread not found: thread-missing" }
            : undefined;
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({
      projectId: "missing-thread",
      resumeThreadId: "thread-missing",
      registry,
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

    const sendPromise = adapter.send("recover this thread");
    await waitForRequestCount(fake, "turn/start", 2);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m-recovered", text: "Recovered" },
      threadId: "thread-recreated",
      turnId: "turn-recreated",
    });
    fake.notify("turn/completed", { threadId: "thread-recreated", turn: { id: "turn-recreated" } });

    const result = await sendPromise;
    assert.equal(result.response, "Recovered");
    assert.equal(adapter.getThreadId(), "thread-recreated");
    assert.equal(turnStartAttempts, 2);
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(
      (fake.requests.filter((request) => request.method === "turn/start")[1]?.params as any).threadId,
      "thread-recreated",
    );
    const fallbackEvent = events.find(
      (event): event is { sessionFallback?: unknown } =>
        typeof event === "object" && event !== null && "sessionFallback" in event,
    );
    assert(fallbackEvent, "expected a session fallback event");
    assert.deepEqual(fallbackEvent.sessionFallback, {
      reason: "missing_provider_session",
      previousSessionId: "thread-missing",
    });

    await registry.stopAll();
  });

  it("recovers when auto-compaction discovers that the resumed thread is missing", async () => {
    let threadStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({
          thread: { id: threadStarts++ === 0 ? "thread-old" : "thread-fresh" },
        }),
        "turn/start": () => ({}),
      },
      autoErrors: {
        "thread/compact/start": () => ({
          code: -32600,
          message: "thread not found: thread-old",
        }),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "missing-compact-thread", registry });

    const firstSend = adapter.send("seed context usage");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("thread/tokenUsage/updated", {
      threadId: "thread-old",
      turnId: "turn-old",
      tokenUsage: {
        total: { totalTokens: 800 },
        last: { totalTokens: 800 },
        modelContextWindow: 1_000,
      },
    });
    fake.notify("turn/completed", { threadId: "thread-old", turn: { id: "turn-old" } });
    await firstSend;

    const secondSend = adapter.send("recover after compaction failure");
    await waitForRequestCount(fake, "thread/compact/start", 1);
    await waitForRequestCount(fake, "turn/start", 2);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m-fresh", text: "Recovered after compaction" },
      threadId: "thread-fresh",
      turnId: "turn-fresh",
    });
    fake.notify("turn/completed", { threadId: "thread-fresh", turn: { id: "turn-fresh" } });

    const result = await secondSend;
    assert.equal(result.response, "Recovered after compaction");
    assert.equal(adapter.getThreadId(), "thread-fresh");
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 2);

    await registry.stopAll();
  });

  it("preserves non-missing resumed thread errors", async () => {
    const fake = buildFakeServer({
      autoErrors: {
        "turn/start": () => ({ code: -32000, message: "upstream connection error" }),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({
      projectId: "non-missing-thread-error",
      resumeThreadId: "thread-still-valid",
      registry,
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

    await assert.rejects(adapter.send("keep the saved thread"), /upstream connection error/);
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 0);
    assert.equal(fake.requests.filter((request) => request.method === "turn/start").length, 1);
    assert.equal(
      events.some(
        (event) => typeof event === "object" && event !== null && "sessionFallback" in event,
      ),
      false,
    );

    await registry.stopAll();
  });

  it("keeps the thread and applies a new model on the next turn", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-model-switch" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "model-switch", model: "gpt-5", registry });

    const firstSend = adapter.send("first");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("turn/completed", { threadId: "thread-model-switch", turn: { id: "turn-1" } });
    await firstSend;
    assert.equal(adapter.getThreadId(), "thread-model-switch");

    adapter.setModel("gpt-5-mini");
    assert.equal(adapter.getThreadId(), "thread-model-switch");

    const secondSend = adapter.send("second");
    await waitForRequestCount(fake, "turn/start", 2);
    const turnStarts = fake.requests.filter((request) => request.method === "turn/start");
    assert.equal(turnStarts[1]?.params?.threadId, "thread-model-switch");
    assert.equal(turnStarts[1]?.params?.model, "gpt-5-mini");
    fake.notify("turn/completed", { threadId: "thread-model-switch", turn: { id: "turn-2" } });
    await secondSend;

    await registry.stopAll();
  });

  it("compacts at 80 percent before starting the next turn", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-compact" } }),
        "thread/compact/start": () => ({}),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "auto-compact", registry });

    const firstSend = adapter.send("first");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("thread/tokenUsage/updated", {
      threadId: "thread-compact",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 800, inputTokens: 700, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
        last: { totalTokens: 800, inputTokens: 700, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
        modelContextWindow: 1_000,
      },
    });
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "first done" },
      threadId: "thread-compact",
      turnId: "turn-1",
    });
    fake.notify("turn/completed", {
      threadId: "thread-compact",
      turn: { id: "turn-1", status: "completed" },
    });

    const firstResult = await firstSend;
    assert.deepEqual(firstResult.usage, {
      input_tokens: 700,
      output_tokens: 100,
      total_tokens: 800,
    });

    const secondSend = adapter.send("second");
    await waitForRequestCount(fake, "thread/compact/start", 1);
    assert.equal(
      fake.requests.filter((request) => request.method === "turn/start").length,
      1,
      "the next user turn must wait for compaction",
    );

    fake.notify("turn/started", {
      threadId: "thread-compact",
      turn: { id: "compact-1", status: "inProgress" },
    });
    fake.notify("item/started", {
      item: { type: "contextCompaction", id: "compact-item-1" },
      threadId: "thread-compact",
      turnId: "compact-1",
    });
    fake.notify("item/completed", {
      item: { type: "contextCompaction", id: "compact-item-1" },
      threadId: "thread-compact",
      turnId: "compact-1",
    });
    fake.notify("turn/completed", {
      threadId: "thread-compact",
      turn: { id: "compact-1", status: "completed" },
    });

    await waitForRequestCount(fake, "turn/start", 2);
    fake.notify("item/completed", {
      item: { type: "agentMessage", id: "m2", text: "second done" },
      threadId: "thread-compact",
      turnId: "turn-2",
    });
    fake.notify("turn/completed", {
      threadId: "thread-compact",
      turn: { id: "turn-2", status: "completed" },
    });

    const secondResult = await secondSend;
    assert.equal(secondResult.response, "second done");
    assert.equal(fake.requests.filter((request) => request.method === "thread/compact/start").length, 1);

    await registry.stopAll();
  });

  it("respects a model-specific auto compact threshold override", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-threshold" } }),
        "thread/compact/start": () => ({}),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "compact-threshold", registry });
    adapter.setModelConfig({ autoCompact: { thresholdPercent: 90 } });

    const firstSend = adapter.send("first");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("thread/tokenUsage/updated", {
      threadId: "thread-threshold",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 850 },
        last: { totalTokens: 850 },
        modelContextWindow: 1_000,
      },
    });
    fake.notify("turn/completed", {
      threadId: "thread-threshold",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstSend;

    const secondSend = adapter.send("second");
    await waitForRequestCount(fake, "turn/start", 2);
    assert.equal(fake.requests.some((request) => request.method === "thread/compact/start"), false);
    fake.notify("turn/completed", {
      threadId: "thread-threshold",
      turn: { id: "turn-2", status: "completed" },
    });
    await secondSend;

    await registry.stopAll();
  });

  it("interrupts a timed-out compact turn before rejecting the next send", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-compact-timeout" } }),
        "thread/compact/start": () => ({}),
        "turn/interrupt": () => ({}),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "compact-timeout", registry });
    adapter.setModelConfig({ autoCompact: { timeoutMs: 20 } });

    const firstSend = adapter.send("first");
    await waitForRequestCount(fake, "turn/start", 1);
    fake.notify("thread/tokenUsage/updated", {
      threadId: "thread-compact-timeout",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 800 },
        last: { totalTokens: 800 },
        modelContextWindow: 1_000,
      },
    });
    fake.notify("turn/completed", {
      threadId: "thread-compact-timeout",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstSend;

    const secondSend = adapter.send("second");
    await waitForRequestCount(fake, "thread/compact/start", 1);
    fake.notify("turn/started", {
      threadId: "thread-compact-timeout",
      turn: { id: "compact-timeout-1", status: "inProgress" },
    });
    await waitForRequestCount(fake, "turn/interrupt", 1);
    fake.notify("turn/completed", {
      threadId: "thread-compact-timeout",
      turn: { id: "compact-timeout-1", status: "interrupted" },
    });

    await assert.rejects(secondSend, /compact turn timed out/);
    assert.equal(
      fake.requests.filter((request) => request.method === "turn/start").length,
      1,
    );

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

  it("does not retry after native collaboration starts", async () => {
    let turnStarts = 0;
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "t-unbridged-item" } }),
        "turn/start": () => {
          turnStarts += 1;
          return {};
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "retry-unbridged-item", registry });

    const sendPromise = adapter.send("retry me");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("item/started", {
      item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent" },
      threadId: "t-unbridged-item",
      turnId: "turn-1",
    });
    fake.notify("error", {
      error: {
        message: "We're currently experiencing high demand, which may cause temporary errors",
      },
      threadId: "t-unbridged-item",
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
