import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerClient } from "../../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../../server/codex/appServer/daemonRegistry.js";
import { CodexAppServerAdapter } from "../../../server/agents/adapters/codexAppServerAdapter.js";

interface RpcLine {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

function buildFakeServer(opts?: {
  autoReplies?: Record<string, (msg: RpcLine) => Record<string, unknown>>;
}) {
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

  return { client, requests, notify };
}

describe("CodexAppServerAdapter goal RPCs", () => {
  it("rejects setGoal when no threadId is set", async () => {
    const fake = buildFakeServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "goal-no-thread", registry });
    await assert.rejects(adapter.setGoal({ objective: "X" }), /requires an active thread/);
    await registry.stopAll();
  });

  it("setGoal issues thread/goal/set with the active threadId and returns the goal", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-g" } }),
        "turn/start": () => ({}),
        "thread/goal/set": (msg) => {
          const params = msg.params as Record<string, unknown>;
          return {
            goal: {
              threadId: String(params.threadId ?? ""),
              objective: String(params.objective ?? "do X"),
              status: "active",
              tokenBudget: params.tokenBudget ?? null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          };
        },
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "goal-1", registry });

    const sendPromise = adapter.send("hello");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/completed", { threadId: "thread-g", turn: { id: "t1" } });
    await sendPromise;

    const goal = await adapter.setGoal({ objective: "do X", tokenBudget: 1000 });
    assert.equal(goal.threadId, "thread-g");
    assert.equal(goal.objective, "do X");
    assert.equal(goal.tokenBudget, 1000);

    const setReq = fake.requests.find((r) => r.method === "thread/goal/set");
    assert(setReq, "thread/goal/set request expected");
    assert.equal((setReq!.params as any).threadId, "thread-g");
    assert.equal((setReq!.params as any).objective, "do X");
    assert.equal((setReq!.params as any).tokenBudget, 1000);

    await registry.stopAll();
  });

  it("getGoal returns the goal payload from thread/goal/get", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-g2" } }),
        "turn/start": () => ({}),
        "thread/goal/get": () => ({
          goal: {
            threadId: "thread-g2",
            objective: "X",
            status: "active",
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 10,
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "goal-2", registry });

    const sendPromise = adapter.send("hi");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/completed", { threadId: "thread-g2", turn: { id: "t" } });
    await sendPromise;

    const goal = await adapter.getGoal();
    assert(goal, "expected goal");
    assert.equal(goal!.tokensUsed, 42);
    assert.equal(goal!.timeUsedSeconds, 10);

    await registry.stopAll();
  });

  it("clearGoal issues thread/goal/clear", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-g3" } }),
        "turn/start": () => ({}),
        "thread/goal/clear": () => ({ cleared: true }),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "goal-3", registry });

    const sendPromise = adapter.send("hi");
    await new Promise((r) => setTimeout(r, 20));
    fake.notify("turn/completed", { threadId: "thread-g3", turn: { id: "t" } });
    await sendPromise;

    await adapter.clearGoal();
    const clearReq = fake.requests.find((r) => r.method === "thread/goal/clear");
    assert(clearReq, "thread/goal/clear request expected");
    assert.equal((clearReq!.params as any).threadId, "thread-g3");

    await registry.stopAll();
  });

  it("dispatches thread/goal/updated and thread/goal/cleared notifications", async () => {
    const fake = buildFakeServer({
      autoReplies: {
        "thread/start": () => ({ thread: { id: "thread-g4" } }),
        "turn/start": () => ({}),
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => fake.client });
    const adapter = new CodexAppServerAdapter({ projectId: "goal-4", registry });

    const updates: any[] = [];
    const cleared: number[] = [];
    adapter.onGoalUpdate((g) => updates.push(g));
    adapter.onGoalCleared(() => cleared.push(Date.now()));

    const sendPromise = adapter.send("hi");
    await new Promise((r) => setTimeout(r, 30));
    fake.notify("turn/completed", { threadId: "thread-g4", turn: { id: "t" } });
    await sendPromise;

    fake.notify("thread/goal/updated", {
      threadId: "thread-g4",
      turnId: "t",
      goal: {
        threadId: "thread-g4",
        objective: "X",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 25,
        timeUsedSeconds: 5,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].tokensUsed, 25);

    fake.notify("thread/goal/cleared", { threadId: "thread-g4" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(cleared.length, 1);

    await registry.stopAll();
  });
});
