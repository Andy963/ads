import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CodexAppServerClient } from "../../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry, type DaemonOptions } from "../../../server/codex/appServer/daemonRegistry.js";

function buildFakeClient(): { client: CodexAppServerClient; stdin: PassThrough; stdout: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({
    stdin,
    stdout,
    stderr,
    waitClose: async () => null,
  });

  let buf = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      }
    }
  });

  return { client, stdin, stdout };
}

describe("CodexAppServerDaemonRegistry", () => {
  it("reuses the same daemon for the same projectId", async () => {
    const built: CodexAppServerClient[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => {
        const { client } = buildFakeClient();
        built.push(client);
        return client;
      },
    });
    const a = await registry.getOrStart("proj-1");
    const b = await registry.getOrStart("proj-1");
    assert.strictEqual(a, b);
    assert.equal(built.length, 1);
    await registry.stopAll();
  });

  it("starts a separate daemon for different projectIds", async () => {
    const built: CodexAppServerClient[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => {
        const { client } = buildFakeClient();
        built.push(client);
        return client;
      },
    });
    const a = await registry.getOrStart("proj-A");
    const b = await registry.getOrStart("proj-B");
    assert.notStrictEqual(a, b);
    assert.equal(built.length, 2);
    await registry.stopAll();
  });

  it("restarts the daemon when working directory changes", async () => {
    const recorded: DaemonOptions[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: (opts) => {
        recorded.push(opts);
        const { client } = buildFakeClient();
        return client;
      },
    });
    const a = await registry.getOrStart("proj-X", { workingDirectory: "/tmp/one" });
    const b = await registry.getOrStart("proj-X", { workingDirectory: "/tmp/two" });
    assert.notStrictEqual(a, b);
    assert.deepEqual(
      recorded.map((r) => r.workingDirectory),
      ["/tmp/one", "/tmp/two"],
    );
    await registry.stopAll();
  });

  it("drops daemons that close unexpectedly and spawns fresh on next call", async () => {
    let factoryCount = 0;
    const clients: { client: CodexAppServerClient; stdout: PassThrough }[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => {
        factoryCount += 1;
        const handle = buildFakeClient();
        clients.push({ client: handle.client, stdout: handle.stdout });
        return handle.client;
      },
    });
    const first = await registry.getOrStart("proj-Z");
    // Simulate unexpected daemon close.
    clients[0].stdout.end();
    // Allow close handlers to fire.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(registry.has("proj-Z"), false);
    const second = await registry.getOrStart("proj-Z");
    assert.notStrictEqual(first, second);
    assert.equal(factoryCount, 2);
    await registry.stopAll();
  });

  it("stop removes the daemon and closes the client", async () => {
    const handles: CodexAppServerClient[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => {
        const { client } = buildFakeClient();
        handles.push(client);
        return client;
      },
    });
    await registry.getOrStart("proj");
    assert.equal(registry.size(), 1);
    await registry.stop("proj");
    assert.equal(registry.size(), 0);
    assert.equal(handles[0].isClosed(), true);
  });
});
