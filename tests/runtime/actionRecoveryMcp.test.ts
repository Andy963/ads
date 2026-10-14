import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { TransientModelRetryAttemptError } from "../../server/agents/adapters/transientModelRetry.js";
import { CodexAppServerClient } from "../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";

const recovery = { actionRecovery: { jobId: "blocked-job", promptId: "recovery-prompt" } };
const empty = { data: [], nextCursor: null };
const unsafe = { data: [{ name: "private-server", tools: {} }], nextCursor: null };
const safeError = "Actions recovery requires a verified empty provider MCP inventory.";
type Request = { id: number; method: string; params: any };
type Reply = { result: unknown } | { error: { code: number; message: string } };

function fixture(t: TestContext, options: {
  resumed?: boolean;
  seedUsage?: boolean;
  reply?: (request: Request) => Reply | null | undefined;
} = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr: new PassThrough(), waitClose: async () => null });
  const registry = new CodexAppServerDaemonRegistry({ factory: () => client });
  t.after(() => registry.stopAll());
  const requests: Request[] = [];
  const firstInventory = Promise.withResolvers<Request>();
  const write = (message: Record<string, unknown>) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const respond = (request: Request, response: Reply) => write({ id: request.id, ...response });
  let buffer = "";
  let freshThreads = 0;
  let turns = 0;
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as Request;
      buffer = buffer.slice(end + 1);
      requests.push(request);
      if (request.id === undefined) continue;
      if (request.method === "mcpServerStatus/list") firstInventory.resolve(request);
      let reply = options.reply?.(request);
      if (reply === null) continue;
      if (reply === undefined) {
        switch (request.method) {
          case "initialize": reply = { result: {} }; break;
          case "thread/start": reply = { result: { thread: { id: `fresh-${++freshThreads}` } } }; break;
          case "thread/resume": reply = { result: { thread: { id: request.params.threadId } } }; break;
          case "mcpServerStatus/list": reply = { result: empty }; break;
          case "turn/start": reply = { result: {} }; break;
          default: reply = { error: { code: -32601, message: "Unexpected fixture request" } };
        }
      }
      respond(request, reply);
      if (request.method === "turn/start" && "result" in reply) {
        const threadId = request.params.threadId;
        const turnId = `turn-${++turns}`;
        queueMicrotask(() => {
          write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
          if (options.seedUsage) write({ method: "thread/tokenUsage/updated", params: {
            threadId, turnId, tokenUsage: { total: { totalTokens: 900 }, last: { totalTokens: 900 }, modelContextWindow: 1_000 },
          } });
          write({ method: "turn/completed", params: { threadId, turn: { id: turnId } } });
        });
      }
    }
  });
  const adapter = new CodexAppServerAdapter({
    projectId: "recovery-mcp-fixture", registry, resumeThreadId: options.resumed ? "saved" : undefined,
    workingDirectory: process.cwd(), sandboxMode: "workspace-write",
  });
  return { adapter, requests, firstInventory: firstInventory.promise, respond,
    calls: (method: string) => requests.filter(request => request.method === method) };
}

function denied(error: unknown): boolean {
  assert.ok(error instanceof TransientModelRetryAttemptError);
  assert.equal(error.message, safeError);
  assert.equal(error.retryable, false);
  assert.equal(error.sideEffectObserved, false);
  assert.equal(error.cause, undefined);
  return true;
}

function assertNoModelWork(f: ReturnType<typeof fixture>): void {
  assert.equal(f.calls("turn/start").length, 0);
  assert.equal(f.calls("thread/compact/start").length, 0);
  assert.equal(f.calls("mcpServer/tool/call").length, 0);
}

describe("recovery-only provider MCP inventory gate", () => {
  for (const resumed of [false, true]) {
    it(`requires every empty inventory page before model work (resumed: ${resumed})`, async t => {
      let pages = 0;
      const f = fixture(t, { resumed, reply: request => request.method === "mcpServerStatus/list"
        ? { result: pages++ === 0 ? { data: [], nextCursor: "page-two" } : empty } : undefined });
      await f.adapter.send("Diagnose", recovery);
      const threadId = resumed ? "saved" : "fresh-1";
      assert.deepEqual(f.calls("mcpServerStatus/list").map(request => request.params), [
        { threadId, detail: "toolsAndAuthOnly", limit: 100 },
        { threadId, detail: "toolsAndAuthOnly", limit: 100, cursor: "page-two" },
      ]);
      assert.ok(f.requests.indexOf(f.calls("mcpServerStatus/list")[1]) < f.requests.indexOf(f.calls("turn/start")[0]));
      assert.equal(f.calls("turn/start")[0].params.approvalPolicy, "never");
      assert.deepEqual(f.calls("turn/start")[0].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      await f.adapter.send("Ordinary follow-up");
      assert.equal(pages, 2);
      assert.equal(f.calls("turn/start")[1].params.threadId, threadId);
      assert.equal(f.calls("turn/start")[1].params.approvalPolicy, "untrusted");
      assert.equal(f.calls("thread/start").length, resumed ? 0 : 1);
    });

    it(`rejects a server on the second page (resumed: ${resumed})`, async t => {
      let pages = 0;
      const f = fixture(t, { resumed, reply: request => request.method === "mcpServerStatus/list"
        ? { result: pages++ === 0 ? { data: [], nextCursor: "next" } : unsafe } : undefined });
      await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
      assert.equal(pages, 2);
      assertNoModelWork(f);
    });
  }

  for (const [name, server] of [
    ["remote mutation", { tools: { merge: { name: "gh_merge", annotations: { readOnlyHint: false } } } }],
    ["readOnlyHint", { tools: { merge: { name: "gh_merge", annotations: { readOnlyHint: true } } } }],
    ["empty server", { tools: {} }],
    ["starting server", { tools: {}, runtimeStatus: "starting" }],
    ["disabled server", { tools: {}, runtimeStatus: "disabled" }],
    ["unverifiable server", { tools: {}, runtimeStatus: null }],
    ["malformed server", null],
  ] as const) {
    it(`rejects ${name} without trusting server metadata`, async t => {
      const f = fixture(t, { reply: request => request.method === "mcpServerStatus/list"
        ? { result: { data: [server], nextCursor: null } } : undefined });
      await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
      assert.equal(f.calls("mcpServerStatus/list").length, 1);
      assertNoModelWork(f);
    });
  }

  for (const [name, result] of [
    ["null response", null], ["array response", []], ["missing data", { nextCursor: null }],
    ["non-array data", { data: {}, nextCursor: null }], ["missing cursor", { data: [] }],
    ["empty cursor", { data: [], nextCursor: "" }], ["blank cursor", { data: [], nextCursor: " " }],
    ["non-string cursor", { data: [], nextCursor: 1 }],
    ["oversized cursor", { data: [], nextCursor: "x".repeat(4_097) }],
  ] as const) {
    it(`fails closed on ${name}`, async t => {
      const f = fixture(t, { reply: request => request.method === "mcpServerStatus/list" ? { result } : undefined });
      await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
      assertNoModelWork(f);
    });
  }

  for (const [code, message] of [[-32601, "private unsupported method"], [-32000, "HTTP 429 private token"], [-32000, "thread not found: private-thread"]] as const) {
    it(`sanitizes RPC failure and never retries or creates a replacement thread (${message})`, async t => {
      const f = fixture(t, { resumed: true, reply: request => request.method === "mcpServerStatus/list"
        ? { error: { code, message } } : undefined });
      await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
      assert.equal(f.calls("mcpServerStatus/list").length, 1);
      assert.equal(f.calls("thread/start").length, 0);
      assertNoModelWork(f);
      await f.adapter.send("Ordinary follow-up");
      assert.equal(f.calls("mcpServerStatus/list").length, 1);
      assert.equal(f.calls("turn/start").length, 1);
    });
  }

  for (const repeated of [true, false]) {
    it(`bounds pagination (${repeated ? "cursor loop" : "page limit"})`, async t => {
      let pages = 0;
      const f = fixture(t, { reply: request => request.method === "mcpServerStatus/list"
        ? { result: { data: [], nextCursor: repeated ? "repeat" : `page-${++pages}` } } : undefined });
      await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
      assert.equal(f.calls("mcpServerStatus/list").length, repeated ? 2 : 32);
      assertNoModelWork(f);
    });
  }

  it("uses one bounded deadline across inventory pages", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const secondInventory = Promise.withResolvers<Request>();
    let pages = 0;
    const f = fixture(t, { reply: request => {
      if (request.method !== "mcpServerStatus/list") return undefined;
      if (++pages === 2) secondInventory.resolve(request);
      return null;
    } });
    const rejected = assert.rejects(f.adapter.send("Diagnose", recovery), denied);
    const first = await f.firstInventory;
    t.mock.timers.tick(4_000);
    f.respond(first, { result: { data: [], nextCursor: "next" } });
    await secondInventory.promise;
    t.mock.timers.tick(1_001);
    await rejected;
    assertNoModelWork(f);
  });

  it("cancels inventory waiting without starting a late model turn", async t => {
    const f = fixture(t, { reply: request => request.method === "mcpServerStatus/list" ? null : undefined });
    const controller = new AbortController();
    const rejected = assert.rejects(f.adapter.send("Diagnose", { ...recovery, signal: controller.signal }),
      (error: Error) => error.name === "AbortError" && !error.message.includes("private"));
    const request = await f.firstInventory;
    controller.abort(new Error("private abort reason"));
    await rejected;
    f.respond(request, { result: empty });
    await new Promise(resolve => setImmediate(resolve));
    assertNoModelWork(f);
  });

  it("skips recovery auto-compaction even when ordinary context exceeds its threshold", async t => {
    const f = fixture(t, { seedUsage: true, reply: request => request.method === "mcpServerStatus/list"
      ? { result: unsafe } : undefined });
    await f.adapter.send("Seed ordinary context");
    await assert.rejects(f.adapter.send("Diagnose", recovery), denied);
    assert.equal(f.calls("thread/compact/start").length, 0);
    assert.equal(f.calls("turn/start").length, 1);
  });

  for (const failsAt of ["thread/resume", "turn/start"] as const) {
    for (const denyReplacement of [false, true]) {
      it(`revalidates the replacement thread after missing ${failsAt} (deny: ${denyReplacement})`, async t => {
        const f = fixture(t, { resumed: true, reply: request => {
          if (request.method === failsAt && request.params.threadId === "saved") {
            return { error: { code: -32000, message: "thread not found: saved" } };
          }
          if (request.method === "mcpServerStatus/list" && request.params.threadId === "fresh-1" && denyReplacement) {
            return { result: unsafe };
          }
          return undefined;
        } });
        const pending = f.adapter.send("Diagnose", recovery);
        if (denyReplacement) await assert.rejects(pending, denied);
        else await pending;
        assert.deepEqual(f.calls("mcpServerStatus/list").map(request => request.params.threadId),
          failsAt === "turn/start" ? ["saved", "fresh-1"] : ["fresh-1"]);
        assert.equal(f.calls("turn/start").filter(request => request.params.threadId === "fresh-1").length, denyReplacement ? 0 : 1);
        assert.equal(f.calls("thread/start").length, 1);
      });
    }
  }

  it("rechecks the same thread on a transient model retry and never retries a failed gate", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let inventories = 0;
    const f = fixture(t, { reply: request => {
      if (request.method === "mcpServerStatus/list") return { result: ++inventories === 1 ? empty : unsafe };
      if (request.method === "turn/start") return { error: { code: -32000, message: "HTTP 429" } };
      return undefined;
    } });
    const retryNotice = Promise.withResolvers<void>();
    f.adapter.onEvent(event => { if (event.retry) retryNotice.resolve(); });
    const rejected = assert.rejects(f.adapter.send("Diagnose", recovery), denied);
    await retryNotice.promise;
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(inventories, 2);
    assert.equal(f.calls("turn/start").length, 1);
    assert.deepEqual(f.calls("mcpServerStatus/list").map(request => request.params.threadId), ["fresh-1", "fresh-1"]);
  });
});
