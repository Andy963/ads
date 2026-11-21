/**
 * Black-box Codex backend conformance for the Rust server: the WebSocket
 * prompt and scheduler executor must both reach a fake codex app-server.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, loginAs, startServerPair } from "./lib/black-box.mjs";

const Database = loadTsServerDependency("better-sqlite3");
const WebSocket = loadTsServerDependency("ws");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");

function startUpstream() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      close: () => new Promise((done) => server.close(done)),
    });
  }));
}

function workspaceId(workspaceRoot) {
  const resolved = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const slug = (path.basename(resolved) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 48);
  return `${slug}-${hash}`;
}

function connect(baseUrl, cookie) {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/ws`,
    ["ads-v1", "ads-session.codex-runtime", "ads-chat.main"],
    { headers: { cookie, origin: baseUrl } },
  );
  const frames = [];
  const waiters = [];
  let failure = null;
  const flush = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (frames.length > 0) {
        waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(frames.shift());
        continue;
      }
      if (failure) {
        waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(failure);
        continue;
      }
      break;
    }
  };
  socket.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch (error) {
      failure = new Error(`invalid JSON frame: ${String(data)} (${error})`);
    }
    flush();
  });
  socket.on("error", (error) => {
    failure = error;
    flush();
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const next = (timeoutMs = 8_000) =>
    new Promise((resolve, reject) => {
      if (frames.length > 0) {
        resolve(frames.shift());
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for WebSocket frame; buffered=${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  return { socket, opened, next, close: () => socket.close() };
}

async function nextMatching(client, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
}

async function runPrompt(client, clientMessageId) {
  client.socket.send(JSON.stringify({
    type: "prompt",
    client_message_id: clientMessageId,
    payload: {
      text: "probe request",
      images: [{
        name: "probe.png",
        mime: "image/png",
        data: "data:image/png;base64,iVBORw0KGgo=",
      }],
    },
  }));
  await nextMatching(
    client,
    (frame) => frame.type === "ack" && frame.client_message_id === clientMessageId,
    "prompt ack",
  );
  const deltas = [];
  const seen = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (frame.type === "delta") deltas.push(String(frame.delta ?? ""));
    if (frame.type === "result") return { result: frame, seen, deltas };
    if (frame.type === "error") {
      throw new Error(`codex prompt failed: ${JSON.stringify(frame)}`);
    }
  }
  throw new Error(`result frame missing; seen=${JSON.stringify(seen)}`);
}

function stateRow(stateDir, sql, ...parameters) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db.prepare(sql).get(...parameters);
  } finally {
    db.close();
  }
}

function scheduleSpec(prompt) {
  return {
    version: 1,
    name: "codex-runtime-sample",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    instruction: "Run the Codex scheduler conformance sample.",
    delivery: {
      channels: ["web"],
      web: { audience: "owner" },
      telegram: { chatId: null },
    },
    policy: {
      workspaceWrite: false,
      network: "deny",
      maxDurationMs: 600_000,
      maxRetries: 0,
      concurrencyKey: "schedule:{scheduleId}",
      idempotencyKeyTemplate: "sch:{scheduleId}:{runAtIso}",
    },
    compiledTask: {
      title: "Codex runtime sample",
      prompt,
      expectedResultSchema: { type: "object" },
      verification: { commands: [] },
    },
    questions: [],
  };
}

function seedSchedule(stateDir, workspace, prompt) {
  const db = new Database(path.join(stateDir, "workspaces.db"));
  try {
    const spec = scheduleSpec(prompt);
    const now = Date.now();
    db.prepare(
      `INSERT INTO schedules (
         workspace_id, id, instruction, spec_json, enabled, next_run_at,
         lease_owner, lease_until, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)`,
    ).run(
      workspaceId(workspace),
      "sched-codex-runtime",
      spec.instruction,
      JSON.stringify(spec),
      now - 60_000,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

async function waitForScheduleRun(pair, workspace, cookie, timeoutMs = 30_000) {
  const query = `?workspace=${encodeURIComponent(workspace)}`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await pair.rustRequest(
      `/api/schedules/sched-codex-runtime/runs${query}`,
      { headers: { cookie } },
    );
    assert(response.status === 200, `runs ${response.status}: ${JSON.stringify(response.body)}`);
    last = response.body?.runs?.[0] ?? null;
    if (last && ["completed", "failed"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`scheduler run did not finish: ${JSON.stringify(last)}`);
}

function inboundTurnStarts(logPath) {
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((message) => message.direction === "inbound" && message.method === "turn/start");
}

function hasInboundMethod(logPath, method) {
  return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).some((line) => {
    const message = JSON.parse(line);
    return message.direction === "inbound" && message.method === method;
  });
}

function localImagePath(turn) {
  return turn.params?.input
    ?.find((part) => part.type === "localImage")
    ?.path;
}

async function main() {
  const upstream = await startUpstream();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-runtime-"));
  const workspace = path.join(sandbox, "workspace");
  const codexHome = path.join(sandbox, "codex-home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(codexHome);
  const fixture = path.join(scriptDir, "fixtures", "fake-codex-app-server.mjs");
  const wrapper = path.join(sandbox, "fake-codex");
  const nodeLog = path.join(sandbox, "node-rpc.log");
  const rustLog = path.join(sandbox, "rust-rpc.log");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "-v" ] || [ "$1" = "version" ] || [ "$1" = "--help" ]; then
  echo "fake-codex 1.0.0"
  exit 0
fi
ADS_APP_SERVER_PROBE_SIMPLE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);

  const pair = await startServerPair({
    root,
    rustDir,
    nodeCwd: root,
    rustCwd: workspace,
    env: {
      ADS_AGENT_RUNTIME: "codex-app-server",
      ADS_CODEX_BIN: wrapper,
      ALLOWED_DIRS: workspace,
      CODEX_HOME: codexHome,
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_API_BASE: "",
      CCHAT_OPENAI_API_KEY: "",
      ADS_SCHEDULER_TICK_MS: "100",
      ADS_SCHEDULER_RUNNER_POLL_MS: "100",
      ADS_SCHEDULER_RUNNER_TIMEOUT_SECS: "10",
      ADS_SCHEDULER_LEASE_TTL_MS: "5000",
    },
    nodeEnv: { ADS_APP_SERVER_PROBE_LOG: nodeLog },
    rustEnv: { ADS_APP_SERVER_PROBE_LOG: rustLog },
  });

  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const nodeClient = connect(pair.nodeBase, nodeLogin.cookie);
    const rustClient = connect(pair.rustBase, rustLogin.cookie);
    try {
      await Promise.all([nodeClient.opened, rustClient.opened]);
      await Promise.all([
        nextMatching(nodeClient, (frame) => frame.type === "welcome", "node welcome"),
        nextMatching(rustClient, (frame) => frame.type === "welcome", "rust welcome"),
      ]);
      const [nodeRun, rustRun] = await Promise.all([
        runPrompt(nodeClient, "cm-codex-node"),
        runPrompt(rustClient, "cm-codex-rust"),
      ]);
      assert(nodeRun.result.ok === true, `node result ${JSON.stringify(nodeRun.result)}`);
      assert(rustRun.result.ok === true, `rust result ${JSON.stringify(rustRun.result)}`);
      assert(nodeRun.result.output === "conformance done", `node output ${nodeRun.result.output}`);
      assert(rustRun.result.output === "conformance done", `rust output ${rustRun.result.output}`);
      assert(rustRun.deltas.join("") === "conformance done", "rust delta stream drifted");

      const queue = stateRow(
        pair.rustStateDir,
        "SELECT status, attempts FROM prompt_queue WHERE client_message_id = ?",
        "cm-codex-rust",
      );
      assert(queue?.status === "completed", `prompt queue ${JSON.stringify(queue)}`);
      const history = stateRow(
        pair.rustStateDir,
        "SELECT text FROM history_entries WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
      );
      assert(history?.text === "conformance done", `history ${JSON.stringify(history)}`);

      const nodeImage = localImagePath(inboundTurnStarts(nodeLog)[0]);
      const rustImage = localImagePath(inboundTurnStarts(rustLog)[0]);
      assert(nodeImage?.includes("web-images"), `node image path ${nodeImage}`);
      assert(rustImage?.includes("web-images"), `rust image path ${rustImage}`);
      assert(!fs.existsSync(rustImage), `rust temp image was not cleaned: ${rustImage}`);

      seedSchedule(
        pair.rustStateDir,
        workspace,
        "Return Codex scheduler conformance output.",
      );
      const run = await waitForScheduleRun(pair, workspace, rustLogin.cookie);
      assert(run.status === "completed", `schedule run failed: ${JSON.stringify(run)}`);
      assert(run.result === "conformance done", `schedule result ${run.result}`);
      const turns = inboundTurnStarts(rustLog);
      assert(turns.length >= 2, `expected websocket and scheduler turns, got ${turns.length}`);
      assert(
        turns.some((turn) => turn.params?.input?.some(
          (part) => part.type === "text" && part.text.includes("scheduler conformance"),
        )),
        "scheduler prompt did not reach the Codex app-server",
      );

      const providerResponse = await pair.rustRequest("/api/model-providers", {
        method: "POST",
        headers: { cookie: rustLogin.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Rollback native provider",
          baseUrl: upstream.baseUrl,
          wireApi: "chat",
          apiKey: "rollback-key",
        }),
      });
      assert(providerResponse.status === 200, `provider ${JSON.stringify(providerResponse)}`);
      const modelResponse = await pair.rustRequest("/api/model-configs", {
        method: "POST",
        headers: { cookie: rustLogin.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          modelId: "rollback-native-model",
          displayName: "Rollback Native",
          provider: providerResponse.body.id,
          providerId: providerResponse.body.id,
          isEnabled: true,
          isDefault: true,
          configJson: { max_output_tokens: 1024 },
        }),
      });
      assert(modelResponse.status === 200, `model ${JSON.stringify(modelResponse)}`);
      const serviceResponse = await pair.rustRequest("/api/model-services/conversation", {
        method: "PUT",
        headers: { cookie: rustLogin.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          modelIds: [modelResponse.body.id],
          defaultModelId: modelResponse.body.id,
        }),
      });
      assert(serviceResponse.status === 200, `service ${JSON.stringify(serviceResponse)}`);

      rustClient.close();
      await pair.restartRust({ ADS_AGENT_RUNTIME: "native" });
      const nativeClient = connect(pair.rustBase, rustLogin.cookie);
      try {
        await nativeClient.opened;
        await nextMatching(nativeClient, (frame) => frame.type === "welcome", "native welcome");
        const nativeRun = await runPrompt(nativeClient, "cm-native-rollback");
        assert(nativeRun.result.ok === true, `native result ${JSON.stringify(nativeRun.result)}`);
        assert(nativeRun.result.output === "Hello world", `native output ${nativeRun.result.output}`);
      } finally {
        nativeClient.close();
      }
      assert(upstream.requests.length >= 1, "native rollback did not call the fake upstream");
      assert(
        upstream.requests.some((request) => request.body.includes("probe request")),
        "native rollback request did not include the prompt",
      );
      await pair.restartRust({ ADS_AGENT_RUNTIME: "codex-app-server" });
      const rolledClient = connect(pair.rustBase, rustLogin.cookie);
      try {
        await rolledClient.opened;
        await nextMatching(rolledClient, (frame) => frame.type === "welcome", "rolled welcome");
        const rolledRun = await runPrompt(rolledClient, "cm-codex-rolled-back");
        assert(rolledRun.result.ok === true, `rolled result ${JSON.stringify(rolledRun.result)}`);
        assert(rolledRun.result.output === "conformance done", `rolled output ${rolledRun.result.output}`);
      } finally {
        rolledClient.close();
      }
      assert(
        hasInboundMethod(rustLog, "thread/resume"),
        "Codex did not resume the persisted thread after rollback",
      );
      const nativeHistory = stateRow(
        pair.rustStateDir,
        "SELECT COUNT(*) AS count FROM history_entries WHERE role = 'ai' AND text = 'Hello world'",
      );
      assert(nativeHistory?.count >= 1, `native history ${JSON.stringify(nativeHistory)}`);
      console.log("ws codex runtime conformance: ok");
    } finally {
      nodeClient.close();
      rustClient.close();
    }
  } catch (error) {
    console.error("--- node output ---\n" + pair.nodeOutput());
    console.error("--- rust output ---\n" + pair.rustOutput());
    throw error;
  } finally {
    await pair.stop();
    await upstream.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
