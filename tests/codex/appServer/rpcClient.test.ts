import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerClient, CodexAppServerRpcClosedError, CodexAppServerRpcError } from "../../../server/codex/appServer/rpcClient.js";

interface JsonRpcLine {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function pair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return { stdin, stdout, stderr };
}

function readLines(stream: PassThrough, onLine: (msg: JsonRpcLine) => void): () => void {
  let buf = "";
  const onData = (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        onLine(JSON.parse(line) as JsonRpcLine);
      } catch {
        // ignore malformed
      }
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

function send(stdout: PassThrough, payload: object): void {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

async function buildStartedClient() {
  const { stdin, stdout, stderr } = pair();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr });

  const detach = readLines(stdin, (msg) => {
    if (msg.method === "initialize" && typeof msg.id !== "undefined") {
      send(stdout, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" },
      });
    }
  });

  await client.start();
  detach();
  return { client, stdin, stdout, stderr };
}

describe("CodexAppServerClient", () => {
  it("starts by sending initialize and resolving the response", async () => {
    const { stdin, stdout, stderr } = pair();
    const client = new CodexAppServerClient();
    client.attach({ stdin, stdout, stderr });

    let observed: JsonRpcLine | null = null;
    readLines(stdin, (msg) => {
      if (!observed) observed = msg;
      if (msg.method === "initialize") {
        send(stdout, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { userAgent: "fake" },
        });
      }
    });

    await client.start();
    assert.equal(observed?.method, "initialize");
    assert.equal(observed?.jsonrpc, "2.0");
    assert.equal(typeof observed?.id, "number");
    await client.close();
  });

  it("correlates request ids with responses", async () => {
    const { client, stdin, stdout } = await buildStartedClient();

    readLines(stdin, (msg) => {
      if (msg.method === "thread/start") {
        send(stdout, { jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-1" } } });
      }
    });

    const result = await client.request<unknown, { thread: { id: string } }>("thread/start", {});
    assert.equal(result.thread.id, "thr-1");
    await client.close();
  });

  it("dispatches notifications to subscribers and unsubscribes correctly", async () => {
    const { client, stdout } = await buildStartedClient();

    const received: Array<{ method: string; params: unknown }> = [];
    const unsub = client.onNotification("thread/started", (params, method) => {
      received.push({ method, params });
    });

    send(stdout, { method: "thread/started", params: { thread: { id: "abc" } } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(received.length, 1);
    assert.equal(received[0].method, "thread/started");

    unsub();
    send(stdout, { method: "thread/started", params: { thread: { id: "abc" } } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(received.length, 1, "should not receive after unsubscribe");

    await client.close();
  });

  it("subscribes to all notifications via '*'", async () => {
    const { client, stdout } = await buildStartedClient();

    const methods: string[] = [];
    client.onNotification("*", (_params, method) => methods.push(method));

    send(stdout, { method: "turn/started", params: {} });
    send(stdout, { method: "turn/completed", params: {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(methods, ["turn/started", "turn/completed"]);

    await client.close();
  });

  it("rejects pending requests when the underlying stdout closes", async () => {
    const { client, stdout } = await buildStartedClient();

    const promise = client.request("turn/start", {});
    stdout.end();
    await assert.rejects(promise, (err: Error) => err instanceof CodexAppServerRpcClosedError);
    await client.close();
  });

  it("propagates server-side errors as CodexAppServerRpcError", async () => {
    const { client, stdin, stdout } = await buildStartedClient();
    readLines(stdin, (msg) => {
      if (msg.method === "thread/start") {
        send(stdout, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "boom" },
        });
      }
    });

    await assert.rejects(client.request("thread/start", {}), (err: Error) => {
      return err instanceof CodexAppServerRpcError && err.message === "boom";
    });

    await client.close();
  });

  it("times out long-running requests", async () => {
    const { client } = await buildStartedClient();
    await assert.rejects(
      client.request("noop", {}, { timeoutMs: 25 }),
      (err: Error) => err instanceof CodexAppServerRpcError && /timed out/.test(err.message),
    );
    await client.close();
  });

  it("invokes close handlers when the stream ends", async () => {
    const { client, stdout } = await buildStartedClient();
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    stdout.end();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, true);
    await client.close();
  });
});
