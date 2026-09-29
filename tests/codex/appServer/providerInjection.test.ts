import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";

import { createGlobalModelConfigStore } from "../../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../../server/state/modelProviderStore.js";
import { createUpstreamCredentialStore } from "../../../server/state/upstreamCredentialStore.js";
import {
  buildCodexProviderInjection,
  codexProviderSlug,
  CODEX_PROVIDER_API_KEY_ENV,
  resolveCodexProviderInjection,
  type CodexProviderInjection,
} from "../../../server/codex/appServer/providerInjection.js";
import { CodexAppServerClient } from "../../../server/codex/appServer/rpcClient.js";
import {
  CodexAppServerDaemonRegistry,
  type DaemonOptions,
} from "../../../server/codex/appServer/daemonRegistry.js";
import { CodexAppServerAdapter } from "../../../server/agents/adapters/codexAppServerAdapter.js";

const SECRET = "provider-injection-test-secret";

interface FakeDaemon {
  client: CodexAppServerClient;
  notify: (method: string, params: Record<string, unknown>) => void;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

function buildFakeDaemon(): FakeDaemon {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr, waitClose: async () => null });
  const requests: FakeDaemon["requests"] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: { threadId?: string } };
      if (msg.method) requests.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      } else if (msg.method === "thread/start") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } })}\n`);
      } else if (msg.method === "thread/resume") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId ?? "thread-1" } } })}\n`);
      } else if (msg.method === "turn/start") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      }
    }
  });
  return {
    client,
    requests,
    notify: (method, params) => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

async function completeTurn(fake: FakeDaemon, threadId = "thread-1"): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  fake.notify("thread/started", { thread: { id: threadId } });
  fake.notify("turn/started", { threadId, turn: { id: "turn-1" } });
  fake.notify("item/completed", {
    item: { type: "agentMessage", id: "m1", text: "done" },
    threadId,
    turnId: "turn-1",
  });
  fake.notify("turn/completed", { threadId, turn: { id: "turn-1" } });
}

async function waitForDaemon(daemons: FakeDaemon[], index: number): Promise<FakeDaemon> {
  const deadline = Date.now() + 2_000;
  while (!daemons[index]) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for daemon #${index}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return daemons[index];
}

describe("codex provider injection", () => {
  let directory: string;
  let db: Database.Database;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-provider-injection-"));
    db = new Database(path.join(directory, "state.db"));
    process.env.ADS_WEB_SESSION_PEPPER = "provider-injection-test-pepper";
  });
  afterEach(() => {
    delete process.env.ADS_WEB_SESSION_PEPPER;
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function seedProvider(overrides: { disabled?: boolean; withKey?: boolean } = {}) {
    const providerStore = createModelProviderStore(db);
    providerStore.upsertProvider({
      id: "provider-openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      wireApi: "responses",
      isEnabled: !overrides.disabled,
    });
    createGlobalModelConfigStore(db).upsertModelConfig({
      id: "model-1",
      modelId: "gpt-5.2",
      displayName: "GPT 5.2",
      provider: "openai",
      providerId: "provider-openrouter",
      isEnabled: true,
      isDefault: false,
    });
    if (overrides.withKey !== false) {
      createUpstreamCredentialStore(db).save(
        "alice",
        { baseUrl: "https://openrouter.ai/api/v1", provider: "provider-openrouter", apiKey: SECRET },
        "provider-openrouter",
      );
    }
  }

  it("builds config overrides with the secret confined to the environment", () => {
    const injection = buildCodexProviderInjection({
      provider: {
        id: "provider-openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        wireApi: "responses",
        isEnabled: true,
      },
      apiKey: SECRET,
    });
    const slug = codexProviderSlug("provider-openrouter");
    assert.equal(slug, "ads-provider-openrouter");
    assert.deepEqual(injection.globalArgs, [
      "-c", `model_providers.${slug}.name="OpenRouter"`,
      "-c", `model_providers.${slug}.base_url="https://openrouter.ai/api/v1"`,
      "-c", `model_providers.${slug}.env_key="${CODEX_PROVIDER_API_KEY_ENV}"`,
      "-c", `model_providers.${slug}.wire_api="responses"`,
      "-c", `model_provider="${slug}"`,
    ]);
    assert.equal(injection.env[CODEX_PROVIDER_API_KEY_ENV], SECRET);
    // AC-2: the secret must never appear in argv (the -c overrides).
    assert.ok(!JSON.stringify(injection.globalArgs).includes(SECRET));
    assert.ok(!JSON.stringify(injection.globalArgs).includes("api_key"));
  });

  it("resolves the provider attached to a model and decrypts at call time", () => {
    seedProvider();
    const injection = resolveCodexProviderInjection({ db, owner: "alice", model: "gpt-5.2" });
    assert.ok(injection);
    assert.equal(injection.providerId, "provider-openrouter");
    assert.equal(injection.env[CODEX_PROVIDER_API_KEY_ENV], SECRET);
    assert.ok(!JSON.stringify(injection.globalArgs).includes(SECRET));

    // The decrypted secret is never persisted: only the AES-GCM envelope is stored.
    const rawKv = JSON.stringify(db.prepare("SELECT * FROM kv_state").all());
    assert.ok(!rawKv.includes(SECRET));
    const rawConfigs = JSON.stringify(db.prepare("SELECT * FROM model_configs").all());
    assert.ok(!rawConfigs.includes(SECRET));
  });

  it("scopes credentials by owner", () => {
    seedProvider();
    assert.throws(
      () => resolveCodexProviderInjection({ db, owner: "bob", model: "gpt-5.2" }),
      /no API key configured/,
    );
  });

  it("does not send an account's old key to a changed provider endpoint", () => {
    seedProvider();
    const providers = createModelProviderStore(db);
    providers.upsertProvider({ ...providers.getProvider("provider-openrouter")!, baseUrl: "https://replacement.invalid/v1" });
    assert.throws(
      () => resolveCodexProviderInjection({ db, owner: "alice", model: "model-1" }),
      /endpoint does not match/,
    );
  });

  it("returns null for models without a provider attachment", () => {
    createGlobalModelConfigStore(db).upsertModelConfig({
      id: "model-legacy",
      modelId: "legacy-model",
      displayName: "Legacy",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
    });
    assert.equal(resolveCodexProviderInjection({ db, owner: "alice", model: "legacy-model" }), null);
    assert.equal(resolveCodexProviderInjection({ db, owner: "alice", model: "missing-model" }), null);
    assert.equal(resolveCodexProviderInjection({ db, owner: "alice", model: "" }), null);
  });

  it("fails closed for unknown, disabled, or keyless providers", () => {
    seedProvider();
    createGlobalModelConfigStore(db).upsertModelConfig({
      id: "model-orphan",
      modelId: "orphan",
      displayName: "Orphan",
      provider: "openai",
      providerId: "provider-missing",
      isEnabled: true,
      isDefault: false,
    });
    assert.throws(
      () => resolveCodexProviderInjection({ db, owner: "alice", model: "orphan" }),
      /unknown provider/,
    );

    seedProvider({ disabled: true });
    assert.throws(
      () => resolveCodexProviderInjection({ db, owner: "alice", model: "gpt-5.2" }),
      /disabled/,
    );
  });

  it("requires a stored credential for the provider", () => {
    seedProvider({ withKey: false });
    assert.throws(
      () => resolveCodexProviderInjection({ db, owner: "alice", model: "gpt-5.2" }),
      /no API key configured/,
    );
  });
});

describe("CodexAppServerAdapter provider injection", () => {
  it("sends upstream model names, not catalog IDs, for new and resumed threads", async () => {
    for (const resumeThreadId of [undefined, "saved-thread"]) {
      const daemons: FakeDaemon[] = [];
      const registry = new CodexAppServerDaemonRegistry({
        factory: () => {
          const daemon = buildFakeDaemon();
          daemons.push(daemon);
          return daemon.client;
        },
      });
      const adapter = new CodexAppServerAdapter({
        projectId: "model-reference-test",
        registry,
        model: "catalog-provider-two-model",
        resumeThreadId,
        resolveModel: (reference) => {
          assert.equal(reference, "catalog-provider-two-model");
          return "shared-upstream-name";
        },
      });
      const pending = adapter.send("hello");
      const daemon = await waitForDaemon(daemons, 0);
      await completeTurn(daemon, resumeThreadId ?? "thread-1");
      await pending;
      const start = daemon.requests.find((request) => request.method === (resumeThreadId ? "thread/resume" : "thread/start"));
      const turn = daemon.requests.find((request) => request.method === "turn/start");
      assert.equal(start?.params.model, "shared-upstream-name");
      assert.equal(turn?.params.model, "shared-upstream-name");
      assert.equal(turn?.params.effort, "high");
    }
  });

  it("spawns the daemon with provider overrides and respawns on provider change", async () => {
    const spawnedOptions: DaemonOptions[] = [];
    const daemons: FakeDaemon[] = [];
    const registry = new CodexAppServerDaemonRegistry({
      factory: (options) => {
        spawnedOptions.push(options);
        const daemon = buildFakeDaemon();
        daemons.push(daemon);
        return daemon.client;
      },
    });

    let injection: CodexProviderInjection | null = buildCodexProviderInjection({
      provider: {
        id: "provider-a",
        name: "Provider A",
        baseUrl: "https://a.test/v1",
        wireApi: "responses",
        isEnabled: true,
      },
      apiKey: "secret-a",
    });

    const adapter = new CodexAppServerAdapter({
      projectId: "demo",
      registry,
      providerInjection: () => injection,
    });

    const first = adapter.send("hello");
    await completeTurn(await waitForDaemon(daemons, 0));
    await first;

    assert.equal(spawnedOptions.length, 1);
    assert.deepEqual(spawnedOptions[0].env, { [CODEX_PROVIDER_API_KEY_ENV]: "secret-a" });
    const args = spawnedOptions[0].globalArgs ?? [];
    assert.ok(args.some((arg) => arg.includes("model_providers.ads-provider-a.base_url")));
    assert.ok(args.some((arg) => arg === 'model_provider="ads-provider-a"'));
    // AC-2: the secret is confined to the daemon environment, never argv.
    assert.ok(!JSON.stringify(args).includes("secret-a"));

    // Same provider: the daemon is reused.
    const second = adapter.send("again");
    await completeTurn(await waitForDaemon(daemons, 0));
    await second;
    assert.equal(spawnedOptions.length, 1);

    // AC-5: a provider change yields a fresh daemon with the new endpoint and key.
    injection = buildCodexProviderInjection({
      provider: {
        id: "provider-b",
        name: "Provider B",
        baseUrl: "https://b.test/v1",
        wireApi: "responses",
        isEnabled: true,
      },
      apiKey: "secret-b",
    });
    const third = adapter.send("after switch");
    await completeTurn(await waitForDaemon(daemons, 1));
    await third;

    assert.equal(spawnedOptions.length, 2);
    assert.deepEqual(spawnedOptions[1].env, { [CODEX_PROVIDER_API_KEY_ENV]: "secret-b" });
    const nextArgs = spawnedOptions[1].globalArgs ?? [];
    assert.ok(nextArgs.some((arg) => arg.includes("model_providers.ads-provider-b.base_url")));
    assert.ok(!JSON.stringify(nextArgs).includes("secret-b"));

    // Detaching the provider returns to a plain daemon without overrides.
    injection = null;
    const fourth = adapter.send("detached");
    await completeTurn(await waitForDaemon(daemons, 2));
    await fourth;
    assert.equal(spawnedOptions.length, 3);
    assert.equal(spawnedOptions[2].globalArgs, undefined);
    assert.equal(spawnedOptions[2].env, undefined);
  });

  it("surfaces provider resolution failures before spawning", async () => {
    const registry = new CodexAppServerDaemonRegistry({
      factory: () => {
        assert.fail("daemon must not spawn when provider resolution fails");
      },
    });
    const adapter = new CodexAppServerAdapter({
      projectId: "demo",
      registry,
      providerInjection: () => {
        throw new Error("Provider \"broken\" has no API key configured for this account.");
      },
    });
    await assert.rejects(() => adapter.send("hello"), /no API key configured/);
  });
});
