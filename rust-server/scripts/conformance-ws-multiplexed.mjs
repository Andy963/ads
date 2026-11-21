/**
 * Black-box conformance for multiplexed Actions/Acopilot lanes on one physical
 * WebSocket: bootstrap tagging, scoped routing, isolated results, and rebinding
 * after an Actions session switch.
 *
 * Node's native runtime needs provider credentials in this harness, so this
 * slice asserts the TypeScript contract directly on the Rust server, matching
 * tests/web/multiplexedLaneSocket.test.ts and tests/web/wsConnection.test.ts.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

import { assert, loginAs, startServerPair } from "./lib/black-box.mjs";

const WebSocket = loadTsServerDependency("ws");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const sessionId = "multiplexed-lanes";

function startUpstream() {
  const requests = [];
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
      requests.push(parsed);
      const serialized = JSON.stringify(parsed.messages ?? []);
      const output = serialized.includes("acopilot hello")
        ? "acopilot-answer"
        : serialized.includes("work hello")
          ? "work-answer"
          : serialized.includes("actions hello")
            ? "actions-answer"
            : "unexpected-answer";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: output }, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write(
        'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function connect(baseUrl, cookie, protocols) {
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
        reject(new Error(`timed out waiting for a WebSocket frame; pending=${JSON.stringify(frames)}`));
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
      throw new Error(`${label} failed: ${error.message}; seen=${JSON.stringify(seen)}`);
    }
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
}

async function runPrompt(client, clientMessageId, chatSessionId, text) {
  client.socket.send(JSON.stringify({
    type: "prompt",
    client_message_id: clientMessageId,
    chat_session_id: chatSessionId,
    payload: { text, images: [] },
  }));
  const ack = await nextMatching(
    client,
    (frame) => frame.type === "ack" && frame.client_message_id === clientMessageId,
    `${chatSessionId} prompt ack`,
  );
  const seen = [...ack.seen];
  const deltas = [];
  let result = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !result) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (frame.type === "delta" && frame.chatSessionId === chatSessionId) {
      deltas.push(String(frame.delta ?? ""));
    }
    if (frame.type === "result") result = frame;
    if (frame.type === "error") {
      throw new Error(`${chatSessionId} prompt failed: ${JSON.stringify(frame)}`);
    }
  }
  assert(result, `${chatSessionId} result frame missing; seen=${JSON.stringify(seen)}`);
  return { ack: ack.frame, result, seen, deltas };
}

async function api(baseUrl, cookie, pathname, method, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  assert(response.ok, `${method} ${pathname} failed: ${response.status} ${text}`);
  return parsed;
}

async function configure(baseUrl, username, password, upstreamBase) {
  const { cookie } = await loginAs(baseUrl, username, password);
  const provider = await api(baseUrl, cookie, "/api/model-providers", "POST", {
    name: "Fake",
    baseUrl: upstreamBase,
    wireApi: "chat",
    apiKey: "test-key",
  });
  const model = await api(baseUrl, cookie, "/api/model-configs", "POST", {
    modelId: "fake-model",
    displayName: "Fake",
    provider: provider.id,
    providerId: provider.id,
    isEnabled: true,
    isDefault: true,
    configJson: { max_output_tokens: 1024 },
  });
  await api(baseUrl, cookie, "/api/model-services/conversation", "PUT", {
    modelIds: [model.id],
    defaultModelId: model.id,
  });
  return cookie;
}

function assertLaneFrame(frame, lane, chatSessionId, label) {
  assert(frame.lane === lane, `${label}: lane=${JSON.stringify(frame.lane)}`);
  assert(
    frame.chatSessionId === chatSessionId,
    `${label}: chatSessionId=${JSON.stringify(frame.chatSessionId)}`,
  );
}

async function main() {
  const upstream = await startUpstream();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-multiplexed-codex-"));
  const pair = await startServerPair({
    root,
    rustDir,
    rustCwd: root,
    nodeCwd: root,
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
    const cookie = await configure(
      pair.rustBase,
      pair.username,
      pair.password,
      upstream.baseUrl,
    );
    const protocols = [
      "ads-v1",
      `ads-session.${sessionId}`,
      "ads-chat.main",
      "ads-chat.acopilot",
    ];
    const client = connect(pair.rustBase, cookie, protocols);
    try {
      await client.opened;
      const firstWelcome = await nextMatching(
        client,
        (frame) => frame.type === "welcome",
        "first welcome",
      );
      const secondWelcome = await nextMatching(
        client,
        (frame) => frame.type === "welcome",
        "second welcome",
      );
      const welcomes = [firstWelcome.frame, secondWelcome.frame];
      const actionsWelcome = welcomes.find((frame) => frame.chatSessionId === "main");
      const acopilotWelcome = welcomes.find((frame) => frame.chatSessionId === "acopilot");
      assert(actionsWelcome, `Actions welcome missing: ${JSON.stringify(welcomes)}`);
      assert(acopilotWelcome, `Acopilot welcome missing: ${JSON.stringify(welcomes)}`);
      assertLaneFrame(actionsWelcome, "actions", "main", "Actions welcome");
      assertLaneFrame(acopilotWelcome, "acopilot", "acopilot", "Acopilot welcome");
      for (const frame of welcomes) {
        assert(
          JSON.stringify(frame.subscribedChatSessionIds) === JSON.stringify(["main", "acopilot"]),
          `welcome subscriptions ${JSON.stringify(frame.subscribedChatSessionIds)}`,
        );
      }

      const actions = await runPrompt(client, "cm-actions", "main", "actions hello");
      assertLaneFrame(actions.ack, "actions", "main", "Actions ack");
      assertLaneFrame(actions.result, "actions", "main", "Actions result");
      assert(actions.result.ok === true, `Actions result ok: ${JSON.stringify(actions.result)}`);
      assert(
        actions.result.output === "actions-answer",
        `Actions output ${JSON.stringify(actions.result.output)}`,
      );
      assert(
        actions.deltas.join("") === "actions-answer",
        `Actions deltas ${JSON.stringify(actions.deltas)}`,
      );

      const acopilot = await runPrompt(
        client,
        "cm-acopilot",
        "acopilot",
        "acopilot hello",
      );
      assertLaneFrame(acopilot.ack, "acopilot", "acopilot", "Acopilot ack");
      assertLaneFrame(acopilot.result, "acopilot", "acopilot", "Acopilot result");
      assert(
        acopilot.result.ok === true,
        `Acopilot result ok: ${JSON.stringify(acopilot.result)}`,
      );
      assert(
        acopilot.result.output === "acopilot-answer",
        `Acopilot output ${JSON.stringify(acopilot.result.output)}`,
      );
      assert(
        acopilot.deltas.join("") === "acopilot-answer",
        `Acopilot deltas ${JSON.stringify(acopilot.deltas)}`,
      );

      client.socket.send(JSON.stringify({
        type: "switch_chat_session",
        chat_session_id: "main",
        payload: { chatSessionId: "work" },
      }));
      const switchedWelcome = await nextMatching(
        client,
        (frame) => frame.type === "welcome" && frame.chatSessionId === "work",
        "switched welcome",
      );
      assertLaneFrame(switchedWelcome.frame, "actions", "work", "Switched welcome");
      assert(
        JSON.stringify(switchedWelcome.frame.subscribedChatSessionIds)
          === JSON.stringify(["work", "acopilot"]),
        `switched subscriptions ${JSON.stringify(switchedWelcome.frame.subscribedChatSessionIds)}`,
      );

      const work = await runPrompt(client, "cm-work", "work", "work hello");
      assertLaneFrame(work.ack, "actions", "work", "Switched ack");
      assertLaneFrame(work.result, "actions", "work", "Switched result");
      assert(work.result.ok === true, `Switched result ok: ${JSON.stringify(work.result)}`);
      assert(
        work.result.output === "work-answer",
        `Switched output ${JSON.stringify(work.result.output)}`,
      );
      assert(
        work.deltas.join("") === "work-answer",
        `Switched deltas ${JSON.stringify(work.deltas)}`,
      );

      const acopilotAfterSwitch = await runPrompt(
        client,
        "cm-acopilot-after-switch",
        "acopilot",
        "acopilot hello again",
      );
      assertLaneFrame(
        acopilotAfterSwitch.ack,
        "acopilot",
        "acopilot",
        "Acopilot ack after switch",
      );
      assertLaneFrame(
        acopilotAfterSwitch.result,
        "acopilot",
        "acopilot",
        "Acopilot result after switch",
      );
      assert(
        acopilotAfterSwitch.result.output === "acopilot-answer",
        `Acopilot output after switch ${JSON.stringify(acopilotAfterSwitch.result.output)}`,
      );

      assert(upstream.requests.length === 4, `upstream requests ${upstream.requests.length}`);
      console.log("ws multiplexed lane conformance: ok");
    } finally {
      client.close();
    }
  } catch (error) {
    console.error("--- rust output ---\n" + pair.rustOutput());
    throw error;
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
