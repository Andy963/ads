/**
 * Black-box WebSocket conformance for durable prompt enqueue ACK, queue
 * snapshots, prompt_queue sync events, and replay after reconnecting.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import WebSocket from "ws";

import { assert, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const sessionId = "prompt-queue-test";
const webUserIdPrefix = 0x700000000000;

function connect(baseUrl, options = {}) {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws${options.search ?? ""}`;
  const headers = { origin: baseUrl };
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
        reject(new Error(`timed out waiting for a WebSocket frame; pending=${JSON.stringify(frames)}`));
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

async function nextMatching(client, predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
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

async function waitForQueueOwner(stateDir) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
    try {
      const row = db
        .prepare("SELECT owner_id, owner_pid FROM prompt_queue_ownership WHERE id = 1")
        .get();
      if (row) return row;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("prompt queue ownership was not claimed");
}

function deriveWebUserId(authUserIdValue, session, chatSessionId, generation) {
  const suffix = generation > 1 ? `:generation:${generation}` : "";
  const base = `${authUserIdValue || "default"}::${session}:${chatSessionId}${suffix}`;
  const digest = crypto.createHash("sha256").update(base).digest();
  return webUserIdPrefix + digest.readUIntBE(0, 6);
}

function readQueueRow(stateDir, clientMessageId) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT client_message_id, user_id, status, attempts, history_key,
                logical_history_key, payload_json
         FROM prompt_queue WHERE client_message_id = ?`,
      )
      .get(clientMessageId);
  } finally {
    db.close();
  }
}

function readQueueEvent(stateDir, clientMessageId) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT seq, event_id, revision, payload
         FROM sync_events
         WHERE event_type = 'prompt_queue' AND event_id = ?`,
      )
      .get(`prompt_queue:${clientMessageId}`);
  } finally {
    db.close();
  }
}

async function main() {
  // Keep prompt execution deterministic: an isolated Codex home prevents the
  // native runner from discovering the operator's real upstream credentials.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-empty-"));
  const pair = await startServerPair({
    root,
    rustDir,
    rustCwd: root,
    nodeCwd: root,
    env: {
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
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const rustUser = authUserId(pair.rustStateDir, pair.username);
    const _nodeUser = authUserId(pair.nodeStateDir, pair.username);
    await Promise.all([
      waitForQueueOwner(pair.rustStateDir),
      waitForQueueOwner(pair.nodeStateDir),
    ]);

    const protocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];
    const node = connect(pair.nodeBase, { cookie: nodeLogin.cookie, protocols });
    const rust = connect(pair.rustBase, { cookie: rustLogin.cookie, protocols });
    try {
      await Promise.all([node.opened, rust.opened]);
      const _nodeBootstrap = await collect(node, 3);
      const _rustBootstrap = await collect(rust, 3);

      const nodeId = "cm-prompt-node";
      const rustId = "cm-prompt-rust";
      node.socket.send(JSON.stringify({
        type: "prompt",
        client_message_id: nodeId,
        payload: { text: "node prompt", images: [] },
      }));
      rust.socket.send(JSON.stringify({
        type: "prompt",
        client_message_id: rustId,
        payload: { text: "rust prompt", images: [] },
      }));

      const nodeAck = await nextMatching(
        node,
        (frame) => frame.type === "ack" && frame.client_message_id === nodeId,
        "node prompt ack",
      );
      const rustAck = await nextMatching(
        rust,
        (frame) => frame.type === "ack" && frame.client_message_id === rustId,
        "rust prompt ack",
      );
      for (const [side, ack] of [["node", nodeAck.frame], ["rust", rustAck.frame]]) {
        assert(ack.duplicate === false, `${side}: first prompt ACK must not be duplicate`);
        assert(
          ["queued", "running", "failed"].includes(ack.queue_status),
          `${side}: unexpected first ACK queue_status ${JSON.stringify(ack.queue_status)}`,
        );
        assert(Number.isInteger(ack.queue_position), `${side}: queue_position missing`);
        assert(Number.isInteger(ack.queue_attempts), `${side}: queue_attempts missing`);
      }

      const rustFailed = await nextMatching(
        rust,
        (frame) =>
          frame.type === "prompt_queue" &&
          frame.entry?.clientMessageId === rustId &&
          frame.entry?.status === "failed",
        "rust failed prompt_queue event",
      );
      assert(
        rustFailed.frame.entry.text === "rust prompt",
        "prompt_queue entry text drifted from the submitted payload",
      );
      assert(Number.isInteger(rustFailed.frame.seq), "prompt_queue event is missing seq");
      assert(
        Array.isArray(rustFailed.frame.entries) &&
          rustFailed.frame.entries.some((entry) => entry.clientMessageId === rustId),
        "prompt_queue event is missing the lane snapshot",
      );

      const queueRow = readQueueRow(pair.rustStateDir, rustId);
      assert(queueRow, "rust prompt_queue row is missing");
      assert(queueRow.status === "failed", `rust prompt_queue status ${queueRow.status}`);
      assert(
        queueRow.user_id === deriveWebUserId(rustUser, sessionId, "main", 1),
        `rust prompt_queue user_id ${queueRow.user_id} does not match TypeScript derivation`,
      );
      const parsedPayload = JSON.parse(queueRow.payload_json);
      assert(parsedPayload.text === "rust prompt", "rust prompt_queue payload text drifted");

      const initialEvent = readQueueEvent(pair.rustStateDir, rustId);
      assert(initialEvent, "rust prompt_queue sync event is missing");
      assert(initialEvent.revision === 24, `rust prompt_queue revision ${initialEvent.revision} != 24`);
      const initialEventPayload = JSON.parse(initialEvent.payload);
      assert(initialEventPayload.type === "prompt_queue", "sync event payload type drifted");
      assert(initialEventPayload.entry.status === "failed", "sync event payload status drifted");

      rust.socket.send(JSON.stringify({
        type: "prompt",
        client_message_id: rustId,
        payload: { text: "rust prompt", images: [] },
      }));
      const duplicateAck = await nextMatching(
        rust,
        (frame) => frame.type === "ack" && frame.client_message_id === rustId,
        "duplicate prompt ack",
      );
      assert(duplicateAck.frame.duplicate === true, "duplicate prompt must ACK duplicate=true");
      assert(
        duplicateAck.frame.queue_status === "failed",
        `duplicate prompt queue_status ${duplicateAck.frame.queue_status}`,
      );

      rust.socket.send(JSON.stringify({
        type: "prompt_reconcile",
        payload: { clientMessageIds: [rustId, "cm-missing"] },
      }));
      const reconciled = await nextMatching(
        rust,
        (frame) => frame.type === "prompt_reconcile_result",
        "prompt reconcile result",
      );
      const identity = (id) =>
        reconciled.frame.identities.find((candidate) => candidate.clientMessageId === id);
      assert(identity(rustId)?.disposition === "consumed", "failed prompt must reconcile as consumed");
      assert(identity(rustId)?.retryable === true, "failed prompt must remain explicitly retryable");
      assert(identity("cm-missing")?.disposition === "unknown", "unknown prompt must reconcile as unknown");

      rust.socket.send(JSON.stringify({
        type: "cancel_prompt",
        client_message_id: rustId,
      }));
      const cancelAck = await nextMatching(
        rust,
        (frame) => frame.type === "ack" && frame.client_message_id === rustId,
        "cancel prompt ack",
      );
      assert(cancelAck.frame.queue_status === "consumed", "failed turn cancellation must ACK consumed");
      assert(cancelAck.frame.duplicate === true, "failed turn cancellation must ACK duplicate");

      rust.socket.send(JSON.stringify({ type: "interrupt" }));
      const idleInterrupt = await nextMatching(
        rust,
        (frame) => frame.type === "error" && frame.errorInfo?.code === "no_active_turn",
        "idle interrupt response",
      );
      assert(idleInterrupt.frame.errorInfo.retryable === false, "idle interrupt must not be retryable");

      rust.socket.send(JSON.stringify({
        type: "prompt",
        payload: { text: "generated id prompt", images: [] },
      }));
      const generatedAck = await nextMatching(
        rust,
        (frame) => frame.type === "ack" && String(frame.client_message_id ?? "").startsWith("server-"),
        "generated prompt ack",
      );
      assert(
        /^server-[0-9a-f-]{36}$/.test(generatedAck.frame.client_message_id),
        `generated client_message_id has the wrong shape: ${generatedAck.frame.client_message_id}`,
      );
      assert(generatedAck.frame.duplicate === false, "generated prompt ACK must not be duplicate");

      rust.socket.send(JSON.stringify({
        type: "prompt",
        client_message_id: "cm-empty",
        payload: { text: "", images: [] },
      }));
      const emptyPrompt = await nextMatching(
        rust,
        (frame) => frame.type === "error" && frame.message === "payload 不能为空",
        "empty prompt error",
      );
      assert(emptyPrompt.frame.type === "error", "empty prompt must be rejected before enqueue");

      const event = readQueueEvent(pair.rustStateDir, rustId);
      assert(event, "rust prompt_queue sync event disappeared");
      assert(event.revision === 24, `rust prompt_queue revision ${event.revision} != 24`);
      rust.close();
      const replay = connect(pair.rustBase, {
        cookie: rustLogin.cookie,
        protocols,
        search: `?afterSeq=${event.seq - 1}&laneGeneration=1`,
      });
      try {
        await replay.opened;
        const replayed = await nextMatching(
          replay,
          (frame) => frame.type === "prompt_queue" && frame.entry?.clientMessageId === rustId,
          "prompt_queue replay",
        );
        assert(
          replayed.frame.seq === event.seq,
          `replayed seq ${replayed.frame.seq} != durable seq ${event.seq}`,
        );
        assert(replayed.frame.entry.status === "failed", "replayed prompt_queue status drifted");
      } finally {
        replay.close();
      }

      console.log("ws prompt queue conformance: ok");
    } finally {
      node.close();
      rust.close();
    }
  } catch (error) {
    console.error("--- node output ---\n" + pair.nodeOutput());
    console.error("--- rust output ---\n" + pair.rustOutput());
    throw error;
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
