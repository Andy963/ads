/**
 * Black-box WebSocket conformance for the Rust /ws handshake, bootstrap,
 * resume replay, authentication and Origin boundaries.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, assertJson, loginAs, startServerPair } from "./lib/black-box.mjs";

const Database = loadTsServerDependency("better-sqlite3");
const WebSocket = loadTsServerDependency("ws");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");

function connect(baseUrl, options = {}) {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws${options.search ?? ""}`;
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  headers.origin = options.origin ?? baseUrl;
  const socket = new WebSocket(url, options.protocols ?? [], { headers });
  const frames = [];
  const waiters = [];
  let closeEvent = null;
  let failure = null;

  const flush = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (frames.length > 0) {
        waiters.shift();
        const timer = waiter.timer;
        if (timer) clearTimeout(timer);
        waiter.resolve(frames.shift());
        continue;
      }
      if (failure) {
        waiters.shift();
        const timer = waiter.timer;
        if (timer) clearTimeout(timer);
        waiter.reject(failure);
        continue;
      }
      break;
    }
  };

  socket.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch (error) {
      failure = new Error(`invalid JSON frame: ${String(data)} (${error})`);
      flush();
      return;
    }
    frames.push(frame);
    flush();
  });
  const closed = new Promise((resolve) => {
    socket.on("close", (code, reason) => {
      closeEvent = { code, reason: String(reason ?? "") };
      resolve(closeEvent);
      flush();
    });
  });
  socket.on("error", (error) => {
    failure = error;
    flush();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const next = (timeoutMs = 5_000) =>
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
        reject(new Error("timed out waiting for a WebSocket frame"));
      }, timeoutMs);
      waiters.push(waiter);
    });

  return {
    socket,
    opened,
    next,
    closed,
    close: () => socket.terminate(),
    closeSnapshot: () => closeEvent,
  };
}

async function collectBootstrap(client, count = 3) {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(await client.next());
  }
  return frames;
}

async function withConnection(baseUrl, options, fn) {
  const client = connect(baseUrl, options);
  try {
    await client.opened;
    return await fn(client);
  } finally {
    client.close();
  }
}

function authUserId(pair, side, _cookie) {
  const stateDir = side === "node" ? pair.nodeStateDir : pair.rustStateDir;
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM web_users WHERE username = ? ORDER BY created_at ASC LIMIT 1")
      .get(pair.username);
    assert(row, `${side}: seeded admin user is missing`);
    return String(row.id);
  } finally {
    db.close();
  }
}

function seedReplayEvents(stateDir, userId) {
  const laneKey = `${userId}::test-session::main`;
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const insert = db.prepare(
      `INSERT INTO sync_events
         (seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const events = [
      {
        seq: 1,
        type: "delta",
        payload: { type: "delta", afterSeq: 0, delta: "hello" },
        ts: 1_700_000_000_000,
      },
      {
        seq: 2,
        type: "command",
        payload: {
          type: "command",
          ts: 1_700_000_000_001,
          command: {
            id: "cmd-1",
            command: "ls",
            status: "running",
            unknown: "dropped",
          },
          unknown: "dropped",
        },
        ts: 1_700_000_000_001,
      },
    ];
    const transaction = db.transaction(() => {
      for (const event of events) {
        insert.run(
          event.seq,
          "web-actions",
          laneKey,
          event.type,
          null,
          1,
          JSON.stringify(event.payload),
          event.ts,
          null,
        );
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

function seedPromptQueueEntries(stateDir, userId) {
  const laneKey = `${userId}::test-session::main`;
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const insert = db.prepare(
      `INSERT INTO prompt_queue (
         client_message_id, auth_user_id, user_id, session_id, chat_session_id,
         history_key, logical_history_key, lane_namespace, lane_generation,
         workspace_root, payload_json, payload_hash, status, attempts, last_error,
         created_at, updated_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', 1, ?, ?, ?, ?, ?)`,
    );
    const rows = [
      {
        clientMessageId: "cm-queue-1",
        payload: { text: "queued text", images: [] },
        lastError: "queue failed",
        createdAt: 1_700_000_002_000,
      },
      {
        clientMessageId: "cm-queue-2",
        payload: { text: "", images: [{ url: "one" }, { url: "two" }], origin: "system" },
        lastError: null,
        createdAt: 1_700_000_002_001,
      },
    ];
    const transaction = db.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.clientMessageId,
          userId,
          1,
          "test-session",
          "main",
          laneKey,
          laneKey,
          "web-actions",
          1,
          root,
          JSON.stringify(row.payload),
          "",
          row.lastError,
          row.createdAt,
          row.createdAt,
          null,
          null,
        );
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

function seedHistoryEntries(stateDir, userId) {
  const laneKey = `${userId}::test-session::main`;
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const insert = db.prepare(
      `INSERT INTO history_entries
         (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const rows = [
      ["user", "hello", 1_700_000_001_000, "client_message_id:cm-history-1"],
      ["ai", "English translation: hi\n\nworld", 1_700_000_001_001, null],
      ["ai", "$ ls\noutput", 1_700_000_001_002, "execute"],
      ["user", "/cd /tmp", 1_700_000_001_003, null],
      ["user", "/cd /var", 1_700_000_001_004, null],
      ["status", "working", 1_700_000_001_005, "status"],
    ];
    const transaction = db.transaction(() => {
      for (const [role, text, ts, kind] of rows) {
        insert.run("web-actions", laneKey, role, text, ts, kind);
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

async function main() {
  const pair = await startServerPair({
    root,
    rustDir,
    rustCwd: root,
    nodeCwd: root,
  });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);

    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const node = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols },
      (client) => collectBootstrap(client),
    );
    const rust = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols },
      (client) => collectBootstrap(client),
    );
    assertJson(rust, node, "ws bootstrap frames");
    assert(node[0].type === "welcome", "node bootstrap did not start with welcome");
    assert(node[2].type === "prompt_queue_snapshot", "node bootstrap order drifted");

    const nodeControl = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols },
      async (client) => {
        await collectBootstrap(client);
        client.socket.send(JSON.stringify({ type: "ping" }));
        const pong = await client.next();
        client.socket.send("not json");
        const invalidJson = await client.next();
        client.socket.send(JSON.stringify([]));
        const invalidPayload = await client.next();
        client.socket.send(
          JSON.stringify({
            type: "prompt",
            chat_session_id: "other",
            client_message_id: "cm-1",
            payload: { text: "ignored" },
          }),
        );
        const sessionChanged = await client.next();
        client.socket.send(
          JSON.stringify({ type: "prompt", chat_session_id: "other", payload: { text: "ignored" } }),
        );
        const sessionChangedWithoutId = await client.next();
        return { pong, invalidJson, invalidPayload, sessionChanged, sessionChangedWithoutId };
      },
    );
    const rustControl = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols },
      async (client) => {
        await collectBootstrap(client);
        client.socket.send(JSON.stringify({ type: "ping" }));
        const pong = await client.next();
        client.socket.send("not json");
        const invalidJson = await client.next();
        client.socket.send(JSON.stringify([]));
        const invalidPayload = await client.next();
        client.socket.send(
          JSON.stringify({
            type: "prompt",
            chat_session_id: "other",
            client_message_id: "cm-1",
            payload: { text: "ignored" },
          }),
        );
        const sessionChanged = await client.next();
        client.socket.send(
          JSON.stringify({ type: "prompt", chat_session_id: "other", payload: { text: "ignored" } }),
        );
        const sessionChangedWithoutId = await client.next();
        return { pong, invalidJson, invalidPayload, sessionChanged, sessionChangedWithoutId };
      },
    );
    assert(nodeControl.pong.type === "pong", "node: ping did not produce pong");
    assert(
      Number.isInteger(nodeControl.pong.ts) && nodeControl.pong.ts > 0,
      "node: pong ts is invalid",
    );
    assert(rustControl.pong.type === "pong", "rust: ping did not produce pong");
    assert(
      Number.isInteger(rustControl.pong.ts) && rustControl.pong.ts > 0,
      "rust: pong ts is invalid",
    );
    for (const field of [
      "invalidJson",
      "invalidPayload",
      "sessionChanged",
      "sessionChangedWithoutId",
    ]) {
      assertJson(rustControl[field], nodeControl[field], `ws control frame ${field}`);
    }
    assert(
      !Object.hasOwn(nodeControl.sessionChangedWithoutId, "clientMessageId"),
      "node: session_changed unexpectedly included clientMessageId",
    );

    for (const [side, baseUrl] of [
      ["node", pair.nodeBase],
      ["rust", pair.rustBase],
    ]) {
      const client = connect(baseUrl, { protocols });
      await client.opened;
      const closed = await client.closed;
      assert(closed.code === 4401, `${side}: expected 4401 without a cookie, got ${closed.code}`);
    }

    for (const [side, baseUrl, cookie] of [
      ["node", pair.nodeBase, nodeLogin.cookie],
      ["rust", pair.rustBase, rustLogin.cookie],
    ]) {
      const client = connect(baseUrl, {
        cookie,
        protocols,
        origin: "https://evil.example",
      });
      await client.opened;
      const closed = await client.closed;
      assert(closed.code === 4403, `${side}: expected 4403 for a cross-site origin, got ${closed.code}`);
    }

    for (const [side, baseUrl, cookie] of [
      ["node", pair.nodeBase, nodeLogin.cookie],
      ["rust", pair.rustBase, rustLogin.cookie],
    ]) {
      const saturated = [];
      try {
        for (let index = 0; index < 32; index += 1) {
          const client = connect(baseUrl, { cookie, protocols });
          await client.opened;
          await client.next();
          saturated.push(client);
        }
        const overflow = connect(baseUrl, { cookie, protocols });
        await overflow.opened;
        const closed = await overflow.closed;
        assert(
          closed.code === 4409,
          `${side}: expected 4409 for the 33rd client, got ${closed.code}`,
        );
      } finally {
        for (const client of saturated) client.close();
      }
    }

    for (const [side, baseUrl, cookie] of [
      ["node", pair.nodeBase, nodeLogin.cookie],
      ["rust", pair.rustBase, rustLogin.cookie],
    ]) {
      const welcome = await withConnection(
        baseUrl,
        { cookie, protocols: ["ads-v1", "ads-session.default", "ads-chat.main"] },
        async (client) => await client.next(),
      );
      assert(
        typeof welcome.sessionId === "string" && welcome.sessionId.length > 0,
        `${side}: default session id is missing`,
      );
      if (side === "node") node.defaultSessionId = welcome.sessionId;
      else {
        assert(
          welcome.sessionId === node.defaultSessionId,
          `default session mapping differs: ${welcome.sessionId} != ${node.defaultSessionId}`,
        );
      }
    }

    const nodeUserId = authUserId(pair, "node", nodeLogin.cookie);
    const rustUserId = authUserId(pair, "rust", rustLogin.cookie);
    seedReplayEvents(pair.nodeStateDir, nodeUserId);
    seedReplayEvents(pair.rustStateDir, rustUserId);
    seedPromptQueueEntries(pair.nodeStateDir, nodeUserId);
    seedPromptQueueEntries(pair.rustStateDir, rustUserId);

    const resumeSearch = "?afterSeq=0&laneGeneration=1";
    const nodeReplay = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols, search: resumeSearch },
      (client) => collectBootstrap(client, 5),
    );
    const rustReplay = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols, search: resumeSearch },
      (client) => collectBootstrap(client, 5),
    );
    assertJson(rustReplay, nodeReplay, "ws resume replay frames");
    assert(nodeReplay[0].historyMode === "resume", "node did not enter resume mode");
    assert(nodeReplay[1].seq === 1 && nodeReplay[2].seq === 2, "node replay sequence drifted");

    seedHistoryEntries(pair.nodeStateDir, nodeUserId);
    seedHistoryEntries(pair.rustStateDir, rustUserId);

    const nodeHistory = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols },
      (client) => collectBootstrap(client, 4),
    );
    const rustHistory = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols },
      (client) => collectBootstrap(client, 4),
    );
    assertJson(rustHistory, nodeHistory, "ws history bootstrap frames");
    assert(nodeHistory[0].bootstrapHistory === true, "node did not mark history bootstrap");
    assert(
      JSON.stringify(nodeHistory[0].completedClientMessageIds) === JSON.stringify(["cm-history-1"]),
      "node completed client message ids drifted",
    );
    assert(nodeHistory[2].type === "history", "node history frame order drifted");
    assert(nodeHistory[2].items.length === 4, "node history sanitization drifted");

    const snapshotSearch = "?afterSeq=0&laneGeneration=1";
    const nodeHistorySnapshot = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols, search: snapshotSearch },
      (client) => collectBootstrap(client, 4),
    );
    const rustHistorySnapshot = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols, search: snapshotSearch },
      (client) => collectBootstrap(client, 4),
    );
    assertJson(
      rustHistorySnapshot,
      nodeHistorySnapshot,
      "ws history snapshot fallback frames",
    );
    assert(
      nodeHistorySnapshot[0].historyMode === "snapshot",
      "node resumed over unsequenced history",
    );

    console.log("ws bootstrap conformance: ok");
  } catch (error) {
    console.error(`node server output:\n${pair.nodeOutput()}`);
    console.error(`rust server output:\n${pair.rustOutput()}`);
    throw error;
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
