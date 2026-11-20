/**
 * Black-box conformance for the in-flight assistant stream contract: live
 * delta frames carry stream offsets, a second connection joining mid-turn gets
 * `inFlight`, the coalesced `delta_snapshot`, and the waiting status, and the
 * snapshot is retired when the turn finishes.
 *
 * Node's native runtime needs provider credentials in this harness, so this
 * slice asserts the TypeScript contract directly on the Rust server.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import WebSocket from "ws";

import { assert, loginAs, request, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const sessionId = "delta-snapshot-test";
const defaultProtocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];

function startUpstream() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
      );
      setTimeout(() => {
        response.write(
          'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n',
        );
        response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
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
    headers: { cookie },
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
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
}

function readDeltaRows(stateDir) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare(
        "SELECT event_id, revision, payload FROM sync_events WHERE event_type = 'delta_snapshot' ORDER BY seq",
      )
      .all()
      .map((row) => ({
        eventId: row.event_id,
        revision: row.revision,
        payload: JSON.parse(row.payload),
      }));
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
  const clientMessageId = "cm-delta-stream";
  const captured = {};
  try {
    await client.opened;
    await nextMatching(client, (frame) => frame.type === "welcome", "welcome");
    client.socket.send(
      JSON.stringify({
        type: "prompt",
        client_message_id: clientMessageId,
        payload: { text: "stream slowly", images: [] },
      }),
    );
    await nextMatching(
      client,
      (frame) => frame.type === "ack" && frame.client_message_id === clientMessageId,
      "prompt ack",
    );
    const firstDelta = await nextMatching(client, (frame) => frame.type === "delta", "first delta");
    captured.firstDelta = firstDelta.frame;
    captured.inFlightEventSeen = firstDelta.seen.some((frame) => frame.type === "in_flight");
    captured.rowsDuringStream = readDeltaRows(stateDir);

    const joiner = connect(baseUrl, cookie);
    try {
      await joiner.opened;
      const welcome = await nextMatching(
        joiner,
        (frame) => frame.type === "welcome",
        "joiner welcome",
      );
      captured.joinerInFlight = welcome.frame.inFlight;
      const snapshot = await nextMatching(
        joiner,
        (frame) => frame.type === "delta_snapshot",
        "joiner delta snapshot",
      );
      captured.snapshot = snapshot.frame;
      const status = await nextMatching(joiner, (frame) => frame.type === "status", "joiner status");
      captured.status = status.frame;
    } finally {
      joiner.close();
    }

    const result = await nextMatching(client, (frame) => frame.type === "result", "result");
    captured.result = result.frame;
  } finally {
    client.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  captured.rowsAfterFinish = readDeltaRows(stateDir);

  const after = connect(baseUrl, cookie);
  try {
    await after.opened;
    const welcome = await nextMatching(after, (frame) => frame.type === "welcome", "idle welcome");
    captured.idleInFlight = welcome.frame.inFlight;
    captured.idleFrames = welcome.seen.map((frame) => frame.type);
  } finally {
    after.close();
  }
  return { ...captured, cookie };
}

async function currentUserId(baseUrl, cookie) {
  const me = await request(baseUrl, "/api/auth/me", { headers: { cookie } });
  assert(me.status === 200, `auth me failed: ${me.status}`);
  return me.body.id;
}

function seedDeltaRow(stateDir, args) {
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const payload = {
      type: "delta_snapshot",
      text: args.text,
      revision: args.revision,
      streamId: args.eventId,
      startOffset: args.startOffset,
      endOffset: args.endOffset,
      ts: args.ts,
      active: true,
    };
    db.prepare(
      `INSERT INTO sync_events
         (namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
       VALUES (?, ?, 'delta_snapshot', ?, ?, ?, ?, NULL)`,
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
  const session = "delta-hydrate";
  const chat = "main";
  const laneKey = `${userId}::${session}::${chat}`;
  const streamId = "stream:delta-hydrate:previous-process:0";
  const seededText = "From old process";
  seedDeltaRow(stateDir, {
    laneKey,
    eventId: streamId,
    text: seededText,
    startOffset: 0,
    endOffset: seededText.length,
    revision: 3,
    ts: Date.now() - 5_000,
  });

  const protocols = ["ads-v1", `ads-session.${session}`, `ads-chat.${chat}`];
  const client = connect(baseUrl, cookie, protocols);
  const captured = {};
  try {
    await client.opened;
    await nextMatching(client, (frame) => frame.type === "welcome", "hydrate welcome");
    client.socket.send(
      JSON.stringify({
        type: "prompt",
        client_message_id: "cm-delta-hydrate",
        payload: { text: "continue after restart", images: [] },
      }),
    );
    await nextMatching(
      client,
      (frame) => frame.type === "ack" && frame.client_message_id === "cm-delta-hydrate",
      "hydrate ack",
    );
    const firstDelta = await nextMatching(
      client,
      (frame) => frame.type === "delta",
      "hydrate first delta",
    );
    captured.firstDelta = firstDelta.frame;

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
        (frame) => frame.type === "delta_snapshot",
        "hydrate joiner snapshot",
      );
      captured.snapshot = snapshot.frame;
    } finally {
      joiner.close();
    }

    const result = await nextMatching(client, (frame) => frame.type === "result", "hydrate result");
    captured.result = result.frame;
  } finally {
    client.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  captured.rowsAfterFinish = readDeltaRows(stateDir).filter((row) => row.eventId === streamId);
  return captured;
}

async function main() {
  const upstream = await startUpstream();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-delta-codex-"));
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

    assert(rust.firstDelta.afterSeq >= 0, "live delta frames must carry afterSeq");
    assert(
      typeof rust.firstDelta.streamId === "string" && rust.firstDelta.streamId.length > 0,
      "live delta frames must carry a streamId",
    );
    assert(
      rust.firstDelta.startOffset === 0 && rust.firstDelta.endOffset === 6,
      `first delta offsets: ${rust.firstDelta.startOffset}-${rust.firstDelta.endOffset}`,
    );
    assert(rust.inFlightEventSeen, "in_flight sync event is missing");
    assert(rust.joinerInFlight === true, `joiner inFlight=${rust.joinerInFlight}`);
    assert(rust.snapshot.bootstrap === true, "bootstrap delta_snapshot must be flagged");
    assert(
      rust.snapshot.text === "Hello ",
      `snapshot text ${JSON.stringify(rust.snapshot.text)}`,
    );
    assert(
      rust.snapshot.startOffset === 0 && rust.snapshot.endOffset === 6,
      `snapshot offsets ${rust.snapshot.startOffset}-${rust.snapshot.endOffset}`,
    );
    assert(
      rust.status.message === "上一轮仍在执行，正在等待后端结果。",
      `status message ${JSON.stringify(rust.status.message)}`,
    );
    assert(rust.result.output === "Hello world", `result ${JSON.stringify(rust.result.output)}`);
    assert(
      rust.rowsDuringStream.length === 1,
      `active delta_snapshot rows: ${JSON.stringify(rust.rowsDuringStream)}`,
    );
    assert(
      rust.rowsDuringStream[0].payload.active !== false,
      "in-flight delta_snapshot row must stay active",
    );
    assert(
      rust.rowsAfterFinish.every((row) => row.payload.active === false),
      `finished turn left an active delta_snapshot: ${JSON.stringify(rust.rowsAfterFinish)}`,
    );
    assert(
      rust.rowsAfterFinish.some((row) => row.payload.text === "Hello world"),
      `sealed snapshot text: ${JSON.stringify(rust.rowsAfterFinish)}`,
    );
    assert(rust.idleInFlight === false, `idle inFlight=${rust.idleInFlight}`);
    assert(
      !rust.idleFrames.includes("delta_snapshot"),
      `idle bootstrap still replayed a snapshot: ${JSON.stringify(rust.idleFrames)}`,
    );

    const hydrate = await runHydrateSide(pair.rustBase, pair.rustStateDir, rust.cookie);
    const seededText = "From old process";
    assert(
      hydrate.firstDelta.streamId === "stream:delta-hydrate:previous-process:0",
      `hydrated streamId ${hydrate.firstDelta.streamId}`,
    );
    assert(
      hydrate.firstDelta.startOffset === seededText.length &&
        hydrate.firstDelta.endOffset === seededText.length + "Hello ".length,
      `hydrated delta offsets ${hydrate.firstDelta.startOffset}-${hydrate.firstDelta.endOffset}`,
    );
    assert(hydrate.joinerInFlight === true, `hydrate joiner inFlight=${hydrate.joinerInFlight}`);
    assert(hydrate.snapshot.bootstrap === true, "hydrated snapshot must be flagged");
    assert(
      hydrate.snapshot.text === `${seededText}Hello `,
      `hydrated snapshot text ${JSON.stringify(hydrate.snapshot.text)}`,
    );
    assert(
      hydrate.snapshot.startOffset === 0 &&
        hydrate.snapshot.endOffset === seededText.length + "Hello ".length,
      `hydrated snapshot offsets ${hydrate.snapshot.startOffset}-${hydrate.snapshot.endOffset}`,
    );
    assert(
      hydrate.result.output === "Hello world",
      `hydrate result ${JSON.stringify(hydrate.result.output)}`,
    );
    assert(
      hydrate.rowsAfterFinish.length === 1 && hydrate.rowsAfterFinish[0].payload.active === false,
      `hydrated row was not sealed: ${JSON.stringify(hydrate.rowsAfterFinish)}`,
    );
    assert(
      hydrate.rowsAfterFinish[0].payload.text === `${seededText}Hello world`,
      `hydrated final text ${JSON.stringify(hydrate.rowsAfterFinish[0].payload.text)}`,
    );

    console.log("ok: ws delta snapshot conformance");
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
