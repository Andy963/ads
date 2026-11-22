/**
 * Black-box WebSocket conformance for in-band lane reset and chat switches.
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
const sessionId = "test-reset";

function connect(baseUrl, options = {}) {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws${options.search ?? ""}`;
  const headers = {};
  headers.origin = options.origin ?? baseUrl;
  if (options.cookie) headers.cookie = options.cookie;
  const socket = new WebSocket(url, options.protocols ?? [], { headers });
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
        reject(new Error(`timed out waiting for a WebSocket frame; received ${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });

  return { socket, opened, next, close: () => socket.close() };
}

async function collect(client, count) {
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

function authUserId(pair, side) {
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

function seedLane(stateDir, userId, chatSessionId = "main", laneSessionId = sessionId) {
  const laneKey = `${userId}::${laneSessionId}::${chatSessionId}`;
  const namespace = chatSessionId === "acopilot" ? "web-acopilot" : "web-actions";
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const insertHistory = db.prepare(
      `INSERT INTO history_entries
         (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO sync_events
         (seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const nextSeq = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM sync_events")
      .get().seq;
    const transaction = db.transaction(() => {
      insertHistory.run(namespace, laneKey, "user", "hello", 1_700_000_000_000, "client_message_id:cm-reset");
      insertHistory.run(namespace, laneKey, "ai", "world", 1_700_000_000_001, null);
      insertEvent.run(
        nextSeq,
        namespace,
        laneKey,
        "delta",
        null,
        1,
        JSON.stringify({ type: "delta", afterSeq: 0, delta: "before reset" }),
        1_700_000_000_002,
        null,
      );
    });
    transaction();
  } finally {
    db.close();
  }
}

function seedProject(stateDir, userId, projectId, workspaceRoot, chatSessionId = "main") {
  const db = new Database(path.join(stateDir, "state.db"));
  try {
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO web_projects
         (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, projectId, workspaceRoot, projectId, chatSessionId, 1, now, now);
  } finally {
    db.close();
  }
}

function readProjectChat(stateDir, userId, projectId) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT chat_session_id FROM web_projects WHERE user_id = ? AND project_id = ?")
      .get(userId, projectId)?.chat_session_id;
  } finally {
    db.close();
  }
}

function readLaneState(stateDir, userId, chatSessionId = "main") {
  const laneKey = `${userId}::${sessionId}::${chatSessionId}`;
  const namespace = chatSessionId === "acopilot" ? "web-acopilot" : "web-actions";
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    const count = (sql, ...args) => db.prepare(sql).get(...args).count;
    return {
      history: count(
        "SELECT COUNT(*) AS count FROM history_entries WHERE namespace = ? AND session_id LIKE ?",
        namespace,
        `${laneKey}%`,
      ),
      syncEvents: count(
        "SELECT COUNT(*) AS count FROM sync_events WHERE namespace = ? AND lane_key LIKE ?",
        namespace,
        `${laneKey}%`,
      ),
      generation: db
        .prepare("SELECT generation FROM web_lane_generations WHERE namespace = ? AND lane_key = ?")
        .get(namespace, laneKey)?.generation,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const pair = await startServerPair({ root, rustDir, rustCwd: root, nodeCwd: root });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const nodeUserId = authUserId(pair, "node");
    const rustUserId = authUserId(pair, "rust");
    seedLane(pair.nodeStateDir, nodeUserId);
    seedLane(pair.rustStateDir, rustUserId);

    const protocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];
    const runResetWithSibling = async (baseUrl, cookie) => {
      const sibling = connect(baseUrl, { cookie, protocols });
      await sibling.opened;
      try {
        await collect(sibling, 4);
        const source = await withConnection(baseUrl, { cookie, protocols }, async (client) => {
          await collect(client, 4);
          client.socket.send(
            JSON.stringify({ type: "clear_history", payload: { scope: "lane" } }),
          );
          return await collect(client, 4);
        });
        return { source, sibling: await collect(sibling, 3) };
      } finally {
        sibling.close();
      }
    };
    const nodeReset = await runResetWithSibling(pair.nodeBase, nodeLogin.cookie);
    const rustReset = await runResetWithSibling(pair.rustBase, rustLogin.cookie);

    assertJson(rustReset, nodeReset, "ws clear_history frames");
    assert(
      nodeReset.source[0].type === "session_reset",
      "node reset did not start with session_reset",
    );
    assert(
      nodeReset.sibling.map((frame) => frame.type).join(",") ===
        "session_reset,welcome,agents",
      "node sibling reset frame order drifted",
    );
    assertJson(
      nodeReset.source[0],
      {
        type: "session_reset",
        source: "clear_history",
        sourceChatSessionId: "main",
        scope: "lane",
        laneGeneration: 2,
      },
      "node session_reset frame",
    );
    assertJson(
      nodeReset.source[3],
      {
        type: "result",
        ok: true,
        output: "已清空历史缓存并重置会话",
        kind: "clear_history",
      },
      "node clear_history result",
    );
    assert(
      nodeReset.source[1].laneGeneration === 2,
      "node did not rebind to generation 2",
    );
    assert(nodeReset.source[1].latestSeq === 0, "node reset latestSeq is not zero");
    assert(
      nodeReset.source[1].bootstrapHistory === false,
      "node reset kept bootstrap history",
    );

    const nodeDb = readLaneState(pair.nodeStateDir, nodeUserId);
    const rustDb = readLaneState(pair.rustStateDir, rustUserId);
    assertJson(rustDb, nodeDb, "post-reset database state");
    assertJson(
      nodeDb,
      { history: 0, syncEvents: 0, generation: 2 },
      "node post-reset database state",
    );

    const staleResume = `?afterSeq=1&laneGeneration=1`;
    const nodeReconnect = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols, search: staleResume },
      (client) => collect(client, 3),
    );
    const rustReconnect = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols, search: staleResume },
      (client) => collect(client, 3),
    );
    assertJson(rustReconnect, nodeReconnect, "post-reset reconnect frames");
    assert(
      nodeReconnect[0].historyMode === "snapshot" && nodeReconnect[0].laneGeneration === 2,
      "node reconnect resumed a stale generation",
    );

    seedLane(pair.nodeStateDir, nodeUserId, "acopilot");
    seedLane(pair.rustStateDir, rustUserId, "acopilot");
    const acopilotProtocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.acopilot"];
    const nodeAcopilot = await withConnection(
      pair.nodeBase,
      { cookie: nodeLogin.cookie, protocols: acopilotProtocols },
      async (client) => {
        await collect(client, 4);
        client.socket.send(JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }));
        return await collect(client, 4);
      },
    );
    const rustAcopilot = await withConnection(
      pair.rustBase,
      { cookie: rustLogin.cookie, protocols: acopilotProtocols },
      async (client) => {
        await collect(client, 4);
        client.socket.send(JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }));
        return await collect(client, 4);
      },
    );
    assertJson(rustAcopilot, nodeAcopilot, "acopilot clear_history frames");
    assert(nodeAcopilot[0].scope === "lane", "node honored shared scope for acopilot");
    assert(nodeAcopilot[0].laneGeneration === 2, "node acopilot reset generation drifted");

    seedLane(pair.nodeStateDir, nodeUserId, "shared-main");
    seedLane(pair.rustStateDir, rustUserId, "shared-main");
    seedLane(pair.nodeStateDir, nodeUserId, "shared-other");
    seedLane(pair.rustStateDir, rustUserId, "shared-other");
    const sharedProtocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.shared-main"];
    const otherProtocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.shared-other"];
    const runSharedReset = async (baseUrl, cookie) => {
      const sibling = connect(baseUrl, { cookie, protocols: otherProtocols });
      await sibling.opened;
      try {
        await collect(sibling, 4);
        const source = await withConnection(baseUrl, { cookie, protocols: sharedProtocols }, async (client) => {
          await collect(client, 4);
          client.socket.send(
            JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }),
          );
          return await collect(client, 4);
        });
        return { source, sibling: await collect(sibling, 3) };
      } finally {
        sibling.close();
      }
    };
    const nodeShared = await runSharedReset(pair.nodeBase, nodeLogin.cookie);
    const rustShared = await runSharedReset(pair.rustBase, rustLogin.cookie);
    assertJson(rustShared, nodeShared, "ws shared clear_history frames");
    assertJson(
      nodeShared.source[0],
      {
        type: "session_reset",
        source: "clear_history",
        sourceChatSessionId: "shared-main",
        scope: "shared",
        laneGeneration: 2,
        laneGenerations: {
          main: 3,
          "shared-main": 2,
          "shared-other": 2,
        },
      },
      "node shared session_reset frame",
    );
    assertJson(
      nodeShared.sibling[0],
      nodeShared.source[0],
      "node shared sibling reset payload",
    );
    assert(
      nodeShared.sibling.map((frame) => frame.type).join(",") ===
        "session_reset,welcome,agents",
      "node shared sibling frame order drifted",
    );
    assert(
      nodeShared.source[1].laneGeneration === 2 &&
        nodeShared.sibling[1].laneGeneration === 2,
      "node shared reset did not rebind each lane",
    );

    for (const [side, stateDir, userId] of [
      ["node", pair.nodeStateDir, nodeUserId],
      ["rust", pair.rustStateDir, rustUserId],
    ]) {
      const sourceState = readLaneState(stateDir, userId, "shared-main");
      const siblingState = readLaneState(stateDir, userId, "shared-other");
      assertJson(
        sourceState,
        { history: 0, syncEvents: 0, generation: 2 },
        `${side} shared source database state`,
      );
      assertJson(
        siblingState,
        { history: 0, syncEvents: 0, generation: 2 },
        `${side} shared sibling database state`,
      );
      assert(
        readLaneState(stateDir, userId, "main").generation === 3,
        `${side} shared reset did not advance main`,
      );
    }

    const switchProjectId = "switch-project";
    seedProject(pair.nodeStateDir, nodeUserId, switchProjectId, root);
    seedProject(pair.rustStateDir, rustUserId, switchProjectId, root);
    seedLane(pair.nodeStateDir, nodeUserId, "switch-alpha", switchProjectId);
    seedLane(pair.rustStateDir, rustUserId, "switch-alpha", switchProjectId);
    const switchProtocols = ["ads-v1", `ads-session.${switchProjectId}`, "ads-chat.main"];
    const runProjectSwitch = async (baseUrl, cookie) => {
      const sibling = connect(baseUrl, { cookie, protocols: switchProtocols });
      await sibling.opened;
      try {
        await collect(sibling, 3);
        const source = await withConnection(baseUrl, { cookie, protocols: switchProtocols }, async (client) => {
          await collect(client, 3);
          client.socket.send(
            JSON.stringify({
              type: "switch_chat_session",
              payload: { chatSessionId: "switch-alpha" },
            }),
          );
          return await collect(client, 4);
        });
        return { source, sibling: await collect(sibling, 4) };
      } finally {
        sibling.close();
      }
    };
    const nodeSwitch = await runProjectSwitch(pair.nodeBase, nodeLogin.cookie);
    const rustSwitch = await runProjectSwitch(pair.rustBase, rustLogin.cookie);
    assertJson(rustSwitch, nodeSwitch, "ws switch_chat_session frames");
    assert(
      nodeSwitch.source[0].type === "welcome" &&
        nodeSwitch.source[0].chatSessionId === "switch-alpha",
      "node switch did not bootstrap the target lane",
    );
    assert(
      nodeSwitch.source[0].bootstrapHistory === true,
      "node switch did not load target history",
    );
    assertJson(
      nodeSwitch.source,
      nodeSwitch.sibling,
      "node project peer switch bootstrap",
    );
    assert(
      readProjectChat(pair.nodeStateDir, nodeUserId, switchProjectId) === "switch-alpha",
      "node switch did not persist the project chat session",
    );
    assert(
      readProjectChat(pair.rustStateDir, rustUserId, switchProjectId) === "switch-alpha",
      "rust switch did not persist the project chat session",
    );

    console.log("ws reset conformance: ok");
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
