/**
 * Black-box conformance for the command runtime snapshot: live `command`
 * frames carry a stable identity plus output offsets, a connection joining
 * mid-turn receives the coalesced `command_snapshot`, and the row is retired
 * when the turn reaches its terminal frame.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, loginAs, request, startServerPair } from "./lib/black-box.mjs";

const Database = loadTsServerDependency("better-sqlite3");
const WebSocket = loadTsServerDependency("ws");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const sessionId = "command-snapshot-test";
const defaultProtocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];

function startUpstream() {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasToolResult = messages.some((message) => message.role === "tool");
      const wantsHydrate = messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content ?? "").includes("hydrate command"),
      );
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (!hasToolResult && wantsHydrate) {
        response.write(
          'data: {"choices":[{"delta":{"content":"working "},"finish_reason":null}]}\n\n',
        );
        setTimeout(() => {
          const toolCallChunk = {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  type: "function",
                  id: "call-cmd-hydrate",
                  function: {
                    name: "exec_command",
                    arguments: JSON.stringify({ cmd: "echo", args: ["hello"] }),
                  },
                }],
              },
              finish_reason: null,
            }],
          };
          response.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
          response.write(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          );
          response.end("data: [DONE]\n\n");
        }, 3_000);
        return;
      }
      if (!hasToolResult) {
        const chunks = [
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  type: "function",
                  id: "call-cmd-1",
                  function: {
                    name: "exec_command",
                    arguments: JSON.stringify({ cmd: "echo", args: ["hello"] }),
                  },
                }],
              },
              finish_reason: null,
            }],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ];
        response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
        return;
      }
      response.write(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
      );
      setTimeout(() => {
        response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\n',
        );
        response.end("data: [DONE]\n\n");
      }, 1_500);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ baseUrl, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function connect(baseUrl, cookie, protocols = defaultProtocols) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, protocols, {
    headers: { cookie, origin: baseUrl },
  });
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
  const next = (timeoutMs = 10_000) =>
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
        reject(new Error(`timed out waiting for a frame; pending=${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  return { socket, opened, next, close: () => socket.close() };
}

async function nextMatching(client, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    let frame;
    try {
      frame = await client.next(Math.max(1, deadline - Date.now()));
    } catch (error) {
      throw new Error(`while waiting for ${label}: ${error.message}; seen=${JSON.stringify(seen)}`);
    }
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
}

function readCommandRows(stateDir) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT payload FROM sync_events WHERE event_type = 'command_snapshot' ORDER BY seq")
      .all()
      .map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}

async function configure(baseUrl, username, password, upstreamBase) {
  const { cookie } = await loginAs(baseUrl, username, password);
  const provider = await request(baseUrl, "/api/model-providers", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Fake",
      baseUrl: upstreamBase,
      wireApi: "chat",
      apiKey: "test-key",
    }),
  });
  assert(provider.status === 200, `provider create failed: ${provider.status}`);
  const model = await request(baseUrl, "/api/model-configs", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      modelId: "fake-model",
      displayName: "Fake",
      provider: provider.body.id,
      providerId: provider.body.id,
      isEnabled: true,
      isDefault: true,
      configJson: { max_output_tokens: 1024 },
    }),
  });
  assert(model.status === 200, `model create failed: ${model.status}`);
  const service = await request(baseUrl, "/api/model-services/conversation", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ modelIds: [model.body.id], defaultModelId: model.body.id }),
  });
  assert(service.status === 200, `model service update failed: ${service.status}`);
  return cookie;
}

async function runSide(baseUrl, stateDir, username, password, upstreamBase) {
  const cookie = await configure(baseUrl, username, password, upstreamBase);
  const client = connect(baseUrl, cookie);
  const captured = {};
  try {
    await client.opened;
    await nextMatching(client, (frame) => frame.type === "welcome", "welcome");
    client.socket.send(
      JSON.stringify({
        type: "prompt",
        client_message_id: "cm-command-snapshot",
        payload: { text: "run echo", images: [] },
      }),
    );
    const started = await nextMatching(
      client,
      (frame) => frame.type === "command" && frame.command?.status === "in_progress",
      "command start",
    );
    captured.started = started.frame;
    const completed = await nextMatching(
      client,
      (frame) => frame.type === "command" && frame.command?.status === "completed",
      "command completion",
    );
    captured.completed = completed.frame;
    captured.rowsDuringStream = readCommandRows(stateDir);

    const joiner = connect(baseUrl, cookie);
    try {
      await joiner.opened;
      const welcome = await nextMatching(joiner, (frame) => frame.type === "welcome", "joiner welcome");
      captured.joinerInFlight = welcome.frame.inFlight;
      const snapshot = await nextMatching(
        joiner,
        (frame) => frame.type === "command_snapshot",
        "joiner command snapshot",
      );
      captured.snapshot = snapshot.frame;
    } finally {
      joiner.close();
    }

    const result = await nextMatching(client, (frame) => frame.type === "result", "result");
    captured.result = result.frame;
  } finally {
    client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  captured.rowsAfterFinish = readCommandRows(stateDir);
  return { ...captured, cookie };
}

async function currentUserId(baseUrl, cookie) {
  const me = await request(baseUrl, "/api/auth/me", { headers: { cookie } });
  assert(me.status === 200, `auth me failed: ${me.status}`);
  return me.body.id;
}

function seedCommandRow(stateDir, args) {
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const payload = {
      type: "command_snapshot",
      active: true,
      ts: args.ts,
      eventId: args.eventId,
      snapshotSeq: null,
      command: args.command,
    };
    db.prepare(
      `INSERT INTO sync_events
         (namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
       VALUES (?, ?, 'command_snapshot', ?, ?, ?, ?, NULL)`,
    ).run(
      "web-actions",
      args.laneKey,
      args.eventId,
      args.revision,
      JSON.stringify(payload),
      args.ts,
    );
  } finally {
    db.close();
  }
}

async function runHydrateSide(baseUrl, stateDir, cookie) {
  const userId = await currentUserId(baseUrl, cookie);
  const session = "command-hydrate";
  const laneKey = `${userId}::${session}::main`;
  const eventId = "active-command:previous-command";
  seedCommandRow(stateDir, {
    laneKey,
    eventId,
    revision: 3,
    ts: Date.now() - 5_000,
    command: {
      id: "previous-command",
      identity: "previous-command",
      command: "previous",
      status: "in_progress",
      startOffset: 0,
      endOffset: 8,
      revision: 3,
    },
  });

  const protocols = ["ads-v1", `ads-session.${session}`, "ads-chat.main"];
  const client = connect(baseUrl, cookie, protocols);
  const captured = {};
  try {
    await client.opened;
    await nextMatching(client, (frame) => frame.type === "welcome", "hydrate welcome");
    client.socket.send(
      JSON.stringify({
        type: "prompt",
        client_message_id: "cm-command-hydrate",
        payload: { text: "hydrate command", images: [] },
      }),
    );
    await nextMatching(
      client,
      (frame) => frame.type === "ack" && frame.client_message_id === "cm-command-hydrate",
      "hydrate ack",
    );

    const joiner = connect(baseUrl, cookie, protocols);
    try {
      await joiner.opened;
      const welcome = await nextMatching(
        joiner,
        (frame) => frame.type === "welcome",
        "hydrate joiner welcome",
      );
      captured.joinerInFlight = welcome.frame.inFlight;
      const snapshot = await nextMatching(
        joiner,
        (frame) => frame.type === "command_snapshot",
        "hydrate joiner command snapshot",
      );
      captured.snapshot = snapshot.frame;
    } finally {
      joiner.close();
    }

    const started = await nextMatching(
      client,
      (frame) => frame.type === "command" && frame.command?.status === "in_progress",
      "hydrate command start",
    );
    captured.started = started.frame;
    const result = await nextMatching(client, (frame) => frame.type === "result", "hydrate result");
    captured.result = result.frame;
  } finally {
    client.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  captured.rowsAfterFinish = readCommandRows(stateDir);
  return captured;
}

async function main() {
  const upstream = await startUpstream();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-codex-"));
  const pair = await startServerPair({
    root,
    rustDir,
    nodeCwd: root,
    rustCwd: root,
    env: {
      ADS_AGENT_RUNTIME: "native",
      CODEX_HOME: codexHome,
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_API_BASE: "",
      CCHAT_OPENAI_API_KEY: "",
    },
  });
  try {
    let rust;
    try {
      rust = await runSide(
        pair.rustBase,
        pair.rustStateDir,
        pair.username,
        pair.password,
        upstream.baseUrl,
      );
    } catch (error) {
      console.error("rust server output:", pair.rustOutput());
      throw error;
    }

    assert(
      rust.started.command?.identity === "call-cmd-1",
      `start identity ${JSON.stringify(rust.started.command)}`,
    );
    assert(
      rust.completed.command?.identity === "call-cmd-1",
      `completion identity ${JSON.stringify(rust.completed.command)}`,
    );
    assert(
      rust.completed.command.outputStartOffset === 0 &&
        rust.completed.command.outputEndOffset >= 5,
      `completion offsets ${JSON.stringify(rust.completed.command)}`,
    );
    assert(rust.joinerInFlight === true, `joiner inFlight=${rust.joinerInFlight}`);
    assert(rust.snapshot.bootstrap === true, "bootstrap command_snapshot must be flagged");
    assert(
      rust.snapshot.command?.identity === "call-cmd-1",
      `snapshot identity ${JSON.stringify(rust.snapshot.command)}`,
    );
    assert(
      rust.snapshot.command?.command === "echo hello",
      `snapshot command ${JSON.stringify(rust.snapshot.command)}`,
    );
    assert(
      rust.snapshot.command?.endOffset === rust.completed.command.outputEndOffset,
      `snapshot offset ${JSON.stringify(rust.snapshot.command)}`,
    );
    assert(rust.rowsDuringStream.length === 1, `rows during stream ${JSON.stringify(rust.rowsDuringStream)}`);
    assert(
      rust.rowsAfterFinish.length === 0,
      `command_snapshot rows after finish: ${JSON.stringify(rust.rowsAfterFinish)}`,
    );
    assert(rust.result.output === "done", `result ${JSON.stringify(rust.result.output)}`);

    const hydrate = await runHydrateSide(pair.rustBase, pair.rustStateDir, rust.cookie);
    assert(hydrate.joinerInFlight === true, `hydrate joiner inFlight=${hydrate.joinerInFlight}`);
    assert(hydrate.snapshot.bootstrap === true, "hydrated command snapshot must be flagged");
    assert(
      hydrate.snapshot.command?.identity === "previous-command",
      `hydrated identity ${JSON.stringify(hydrate.snapshot.command)}`,
    );
    assert(
      hydrate.snapshot.command?.command === "previous",
      `hydrated command ${JSON.stringify(hydrate.snapshot.command)}`,
    );
    assert(
      hydrate.snapshot.command?.status === "in_progress",
      `hydrated status ${JSON.stringify(hydrate.snapshot.command)}`,
    );
    assert(
      hydrate.snapshot.command?.startOffset === 0 &&
        hydrate.snapshot.command?.endOffset === 8,
      `hydrated offsets ${JSON.stringify(hydrate.snapshot.command)}`,
    );
    assert(
      hydrate.started.command?.identity === "call-cmd-hydrate",
      `hydrate real identity ${JSON.stringify(hydrate.started.command)}`,
    );
    assert(
      hydrate.result.output === "done",
      `hydrate result ${JSON.stringify(hydrate.result.output)}`,
    );
    assert(
      hydrate.rowsAfterFinish.length === 0,
      `hydrate left command_snapshot rows: ${JSON.stringify(hydrate.rowsAfterFinish)}`,
    );

    console.log("ok: ws command snapshot conformance");
  } finally {
    await pair.stop();
    await upstream.close();
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
