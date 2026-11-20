/**
 * Black-box WebSocket conformance for command dispatch, builtins, cwd
 * persistence, blocked slash commands, and silent command payloads.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import WebSocket from "ws";

import { assert, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const sessionId = "command-test";

function connect(baseUrl, options = {}) {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  const socket = new WebSocket(url, options.protocols ?? [], { headers });
  const frames = [];
  const history = [];
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
      const frame = JSON.parse(String(data));
      frames.push(frame);
      history.push(frame);
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
        reject(
          new Error(
            `timed out waiting for a WebSocket frame; recent=${JSON.stringify(history.slice(-8))}`,
          ),
        );
      }, timeoutMs);
      waiters.push(waiter);
    });

  return { socket, opened, next, close: () => socket.close() };
}

async function collectBootstrap(client, count = 3) {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(await client.next());
  }
  return frames;
}

function normalize(frame) {
  const clone = { ...frame };
  delete clone.seq;
  delete clone.ts;
  return clone;
}

function authUserId(stateDir, username) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM web_users WHERE username = ? ORDER BY created_at ASC LIMIT 1")
      .get(username);
    assert(row, "seeded admin user is missing");
    return String(row.id);
  } finally {
    db.close();
  }
}

function readCwdStore(stateDir) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT key, value FROM kv_state WHERE namespace = 'web_cwd' ORDER BY key")
      .all();
  } finally {
    db.close();
  }
}

async function readExecuteHistory(stateDir, userId) {
  const laneKey = `${userId}::${sessionId}::main`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT text FROM history_entries
           WHERE namespace = 'web-actions' AND session_id = ? AND kind = 'execute'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(laneKey);
      if (row) return row.text;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("execute history row was not written");
}

function countHistory(stateDir, userId) {
  const laneKey = `${userId}::${sessionId}::main`;
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare(
        "SELECT COUNT(*) AS count FROM history_entries WHERE namespace = 'web-actions' AND session_id = ?",
      )
      .get(laneKey).count;
  } finally {
    db.close();
  }
}

async function runScenario(pair, baseUrl, cookie, stateDir) {
  const protocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];
  const userId = authUserId(stateDir, pair.username);
  const client = connect(baseUrl, { cookie, protocols });
  const captured = {};
  const command = (payload, clientMessageId) =>
    client.socket.send(
      JSON.stringify({
        type: "command",
        ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
        payload,
      }),
    );
  await client.opened;
  try {
    await collectBootstrap(client);

    command("/pwd", "cm-pwd-initial");
    captured.pwdInitial = [await client.next(), await client.next(), await client.next()];

    command("/cd server");
    captured.cdResult = await client.next();
    captured.cdWorkspace = await client.next();

    command("/pwd", "cm-pwd-after-cd");
    captured.pwdAfterCd = [await client.next(), await client.next(), await client.next()];

    command("/conformance-unknown", "cm-conformance-command");
    captured.unknown = [
      await client.next(),
      await client.next(),
      await client.next(),
      await client.next(),
    ];
    captured.executeHistory = await readExecuteHistory(stateDir, userId);

    command({});
    captured.emptyPayloadError = await client.next();

    command("/search hello", "cm-search-blocked");
    command("/pwd", "cm-pwd-after-blocked");
    captured.blockedAndFollowUp = [
      await client.next(),
      await client.next(),
      await client.next(),
      await client.next(),
      await client.next(),
    ];

    command({ command: "/cd server", silent: true }, "cm-silent-cd");
    captured.silentWorkspace = await client.next();

    captured.cwdStore = readCwdStore(stateDir);

    command("/clear", "cm-clear");
    captured.clear = [await client.next(), await client.next(), await client.next()];
    captured.historyAfterClear = countHistory(stateDir, userId);
  } finally {
    client.close();
  }

  const reconnect = connect(baseUrl, { cookie, protocols });
  await reconnect.opened;
  try {
    await collectBootstrap(reconnect);
    reconnect.socket.send(
      JSON.stringify({
        type: "command",
        client_message_id: "cm-pwd-after-reconnect",
        payload: "/pwd",
      }),
    );
    captured.pwdAfterReconnect = [
      await reconnect.next(),
      await reconnect.next(),
      await reconnect.next(),
    ];
    return captured;
  } finally {
    reconnect.close();
  }
}

function compareFrames(label, node, rust) {
  const normalizedNode = normalize(node);
  const normalizedRust = normalize(rust);
  assert(
    JSON.stringify(normalizedNode) === JSON.stringify(normalizedRust),
    `${label}: node=${JSON.stringify(normalizedNode)} rust=${JSON.stringify(normalizedRust)}`,
  );
}

function compareFrameLists(label, node, rust) {
  assert(node.length === rust.length, `${label}: frame counts differ`);
  node.forEach((frame, index) => compareFrames(`${label}[${index}]`, frame, rust[index]));
}

async function main() {
  const pair = await startServerPair({ root, rustDir, rustCwd: root, nodeCwd: root });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const node = await runScenario(pair, pair.nodeBase, nodeLogin.cookie, pair.nodeStateDir);
    let rust;
    try {
      rust = await runScenario(pair, pair.rustBase, rustLogin.cookie, pair.rustStateDir);
    } catch (error) {
      console.error("rust server output:", pair.rustOutput());
      console.error("node server output:", pair.nodeOutput());
      throw error;
    }

    const expectedCwd = path.join(root, "ts-server", "server");
    compareFrameLists("pwd initial", node.pwdInitial, rust.pwdInitial);
    compareFrames("cd result", node.cdResult, rust.cdResult);
    compareFrames("cd workspace", node.cdWorkspace, rust.cdWorkspace);
    compareFrameLists("pwd after cd", node.pwdAfterCd, rust.pwdAfterCd);
    compareFrameLists("unknown command", node.unknown, rust.unknown);
    compareFrames("empty payload error", node.emptyPayloadError, rust.emptyPayloadError);
    compareFrameLists("blocked slash follow-up", node.blockedAndFollowUp, rust.blockedAndFollowUp);
    compareFrames("silent cd workspace", node.silentWorkspace, rust.silentWorkspace);
    compareFrameLists("clear", node.clear, rust.clear);
    compareFrameLists("pwd after reconnect", node.pwdAfterReconnect, rust.pwdAfterReconnect);

    assert(
      node.pwdInitial[2]?.output === `当前工作目录: ${root}` &&
        rust.pwdInitial[2]?.output === `当前工作目录: ${root}`,
      "initial pwd output differs from the restored cwd",
    );
    assert(
      node.pwdAfterCd[2]?.output === `当前工作目录: ${expectedCwd}` &&
        rust.pwdAfterCd[2]?.output === `当前工作目录: ${expectedCwd}`,
      "cd did not update the lane cwd",
    );
    assert(
      node.blockedAndFollowUp[0]?.type === "user" &&
        node.blockedAndFollowUp[0]?.text === "/search hello" &&
        node.blockedAndFollowUp[2]?.text === "/pwd" &&
        node.blockedAndFollowUp[4]?.output === `当前工作目录: ${expectedCwd}` &&
        rust.blockedAndFollowUp[2]?.text === "/pwd" &&
        rust.blockedAndFollowUp[4]?.output === `当前工作目录: ${expectedCwd}`,
      "blocked /search command emitted an unexpected frame",
    );
    assert(
      node.unknown[2]?.ok === false &&
        node.unknown[2]?.kind === "execute" &&
        node.unknown[2]?.command === "/conformance-unknown" &&
        node.unknown[3]?.type === "workspace",
      "unknown command frames drifted",
    );
    assert(
      node.clear[2]?.kind === "clear_history" &&
        rust.clear[2]?.kind === "clear_history",
      "clear command result drifted",
    );
    assert(
      node.executeHistory === "$ /conformance-unknown\n❓ Unsupported command",
      `node execute history: ${node.executeHistory}`,
    );
    assert(node.executeHistory === rust.executeHistory, "execute history differs");
    assert(node.historyAfterClear === 0, `node history after clear: ${node.historyAfterClear}`);
    assert(rust.historyAfterClear === 0, `rust history after clear: ${rust.historyAfterClear}`);
    assert(
      node.cwdStore.some((row) => row.value === expectedCwd) &&
        rust.cwdStore.some((row) => row.value === expectedCwd),
      `cwd store did not persist ${expectedCwd}`,
    );
    assert(
      node.cwdStore.length === rust.cwdStore.length,
      "cwd store row counts differ",
    );
    assert(
      node.pwdAfterReconnect[2]?.output === `当前工作目录: ${expectedCwd}` &&
        rust.pwdAfterReconnect[2]?.output === `当前工作目录: ${expectedCwd}`,
      "cwd was not restored after reconnect",
    );
    assert(
      node.cdWorkspace.data?.path === expectedCwd && rust.cdWorkspace.data?.path === expectedCwd,
      "workspace frame did not report the new cwd",
    );
    assert(
      node.silentWorkspace.data?.path === expectedCwd &&
        rust.silentWorkspace.data?.path === expectedCwd,
      "silent cd did not broadcast workspace state",
    );

    console.log("ok: ws command conformance");
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
