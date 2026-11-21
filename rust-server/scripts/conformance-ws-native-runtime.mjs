/**
 * Black-box Native Runtime conformance: a real Rust server executes a queued
 * prompt against a local OpenAI-compatible SSE endpoint and streams the result
 * back over WebSocket.
 */
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
const sessionId = "native-runtime-test";

function startUpstream() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ url: request.url, body, parsed });
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const wantsTools = JSON.stringify(messages).includes("read and patch");
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (wantsTools && !hasToolResult) {
        const patch = [
          "*** Begin Patch",
          "*** Add File: conformance-tool.txt",
          "+created by native runtime conformance",
          "*** End Patch",
        ].join("\n");
        const chunks = [
          {
            choices: [{
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    type: "function",
                    id: "read-conformance",
                    function: { name: "read_file", arguments: JSON.stringify({ file: "notes.txt" }) },
                  },
                  {
                    index: 1,
                    type: "function",
                    id: "patch-conformance",
                    function: { name: "apply_patch", arguments: JSON.stringify({ patch }) },
                  },
                ],
              },
              finish_reason: null,
            }],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          {
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          },
        ];
        response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
        return;
      }
      if (wantsTools) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "patched" }, finish_reason: "stop" }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(
        'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
      );
      response.write(
        'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n',
      );
      response.write(
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
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
        reject(new Error(`timed out waiting for a WebSocket frame; pending=${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  return { socket, opened, next, close: () => socket.close() };
}

async function nextMatching(client, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (predicate(frame)) return { frame, seen };
  }
  throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen)}`);
}

async function runPrompt(client, clientMessageId, text) {
  client.socket.send(JSON.stringify({
    type: "prompt",
    client_message_id: clientMessageId,
    payload: { text, images: [] },
  }));
  await nextMatching(
    client,
    (frame) => frame.type === "ack" && frame.client_message_id === clientMessageId,
    "prompt ack",
  );
  const deltas = [];
  const seen = [];
  const deadline = Date.now() + 20_000;
  let result = null;
  while (Date.now() < deadline && !result) {
    const frame = await client.next(Math.max(1, deadline - Date.now()));
    seen.push(frame);
    if (frame.type === "delta") deltas.push(String(frame.delta ?? ""));
    if (frame.type === "result") result = frame;
    if (frame.type === "error") {
      throw new Error(`native prompt failed: ${JSON.stringify(frame)}`);
    }
  }
  assert(result, `result frame missing; seen=${JSON.stringify(seen)}`);
  return { result, seen, deltas };
}

async function runPromptExpectError(client, clientMessageId, text) {
  client.socket.send(JSON.stringify({
    type: "prompt",
    client_message_id: clientMessageId,
    payload: { text, images: [] },
  }));
  await nextMatching(
    client,
    (frame) => frame.type === "ack" && frame.client_message_id === clientMessageId,
    "prompt ack",
  );
  const { frame } = await nextMatching(
    client,
    (item) => item.type === "error" || item.type === "result",
    "prompt failure",
  );
  assert(frame.type === "error", `expected an error frame, got ${JSON.stringify(frame)}`);
  return frame;
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

function stateRow(stateDir, sql, ...parameters) {
  const db = new Database(path.join(stateDir, "state.db"), { readonly: true });
  try {
    return db.prepare(sql).get(...parameters);
  } finally {
    db.close();
  }
}

async function main() {
  const upstream = await startUpstream();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-workspace-"));
  fs.writeFileSync(path.join(workspace, "notes.txt"), "alpha\nbeta\n", "utf8");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-empty-"));
  const pair = await startServerPair({
    root,
    rustDir,
    rustCwd: workspace,
    nodeCwd: root,
    env: {
      ADS_AGENT_RUNTIME: "native",
      ALLOWED_DIRS: workspace,
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
    const login = await loginAs(pair.rustBase, pair.username, pair.password);
    const provider = await api(pair.rustBase, login.cookie, "/api/model-providers", "POST", {
      name: "Fake",
      baseUrl: upstream.baseUrl,
      wireApi: "chat",
      apiKey: "test-key",
    });
    const model = await api(pair.rustBase, login.cookie, "/api/model-configs", "POST", {
      modelId: "fake-model",
      displayName: "Fake",
      provider: provider.id,
      providerId: provider.id,
      isEnabled: true,
      isDefault: true,
      configJson: { max_output_tokens: 1024 },
    });
    await api(
      pair.rustBase,
      login.cookie,
      "/api/model-services/conversation",
      "PUT",
      { modelIds: [model.id], defaultModelId: model.id },
    );

    const protocols = ["ads-v1", `ads-session.${sessionId}`, "ads-chat.main"];
    const client = connect(pair.rustBase, login.cookie, protocols);
    try {
      await client.opened;
      await nextMatching(client, (frame) => frame.type === "welcome", "welcome");
      const clientMessageId = "cm-native-success";
      const { result, seen, deltas } = await runPrompt(client, clientMessageId, "say hello");
      assert(result.ok === true, `result ok drifted: ${JSON.stringify(result)}`);
      assert(result.output === "Hello world", `result output ${JSON.stringify(result.output)}`);
      assert(result.effectiveModel === "fake-model", `effectiveModel ${result.effectiveModel}`);
      assert(deltas.join("") === "Hello world", `delta stream ${JSON.stringify(deltas)}`);
      assert(
        seen.some((frame) => frame.type === "user" && frame.eventId === `user:${clientMessageId}`),
        "user sync event is missing",
      );

      let queue = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        queue = stateRow(
          pair.rustStateDir,
          "SELECT status, attempts FROM prompt_queue WHERE client_message_id = ?",
          clientMessageId,
        );
        if (queue?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(queue?.status === "completed", `prompt_queue status ${queue?.status}`);
      assert(queue.attempts === 1, `prompt_queue attempts ${queue.attempts}`);
      const history = stateRow(
        pair.rustStateDir,
        "SELECT role, text, kind FROM history_entries WHERE role = 'ai' ORDER BY id DESC LIMIT 1",
      );
      assert(history.text === "Hello world", `history text ${JSON.stringify(history.text)}`);
      const userHistory = stateRow(
        pair.rustStateDir,
        "SELECT kind FROM history_entries WHERE role = 'user' ORDER BY id DESC LIMIT 1",
      );
      assert(
        String(userHistory.kind).includes("eff_model=fake-model"),
        `user history kind ${userHistory.kind}`,
      );
      const persisted = stateRow(
        pair.rustStateDir,
        "SELECT COUNT(*) AS count FROM sync_events WHERE event_type = 'delta'",
      );
      assert(persisted.count === 0, "delta frames must not be persisted");
      const resultEvent = stateRow(
        pair.rustStateDir,
        "SELECT payload FROM sync_events WHERE event_type = 'result' ORDER BY seq DESC LIMIT 1",
      );
      assert(resultEvent, "result sync event is missing");
      assert(
        JSON.parse(resultEvent.payload).output === "Hello world",
        "persisted result event drifted",
      );
      const transcript = stateRow(
        pair.rustStateDir,
        "SELECT status FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
      );
      assert(transcript.status === "completed", `transcript status ${transcript.status}`);

      assert(upstream.requests.length >= 1, "fake upstream was not called");
      const upstreamBody = JSON.parse(upstream.requests[0].body);
      assert(upstreamBody.stream === true, "native runner must request a stream");
      assert(upstreamBody.model === "fake-model", `upstream model ${upstreamBody.model}`);

      const toolMessageId = "cm-native-tools";
      const toolRun = await runPrompt(client, toolMessageId, "read and patch");
      assert(toolRun.result.ok === true, `tool result ok drifted: ${JSON.stringify(toolRun.result)}`);
      assert(toolRun.result.output === "patched", `tool result output ${JSON.stringify(toolRun.result.output)}`);
      assert(toolRun.deltas.join("") === "patched", `tool deltas ${JSON.stringify(toolRun.deltas)}`);
      assert(
        fs.readFileSync(path.join(workspace, "conformance-tool.txt"), "utf8")
          === "created by native runtime conformance\n",
        "apply_patch did not write the expected file",
      );
      let toolQueue = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        toolQueue = stateRow(
          pair.rustStateDir,
          "SELECT status, attempts FROM prompt_queue WHERE client_message_id = ?",
          toolMessageId,
        );
        if (toolQueue?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(toolQueue?.status === "completed", `tool prompt_queue status ${toolQueue?.status}`);
      const toolEntries = JSON.parse(stateRow(
        pair.rustStateDir,
        "SELECT entries_json FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
      ).entries_json);
      assert(
        toolEntries.some((entry) => entry.kind === "file_change"
          && entry.changes?.some((change) => change.path === "conformance-tool.txt")),
        `tool transcript file_change missing: ${JSON.stringify(toolEntries)}`,
      );
      const toolRoundBody = upstream.requests.at(-1).parsed;
      const toolMessages = toolRoundBody.messages.filter((message) => message.role === "tool");
      assert(toolMessages.length === 2, `tool result messages ${JSON.stringify(toolMessages)}`);
      assert(
        toolMessages.some((message) => String(message.content).includes("alpha")),
        "read_file result did not reach the provider",
      );
      assert(
        toolMessages.some((message) => String(message.content).includes("applied")),
        "apply_patch result did not reach the provider",
      );
      const unsupportedModel = await api(
        pair.rustBase,
        login.cookie,
        "/api/model-configs",
        "POST",
        {
          modelId: "unsupported-model",
          displayName: "Unsupported",
          provider: provider.id,
          providerId: provider.id,
          isEnabled: true,
          isDefault: false,
          configJson: {
            max_output_tokens: 1024,
            capabilities: { toolCalls: "unsupported" },
          },
        },
      );
      await api(
        pair.rustBase,
        login.cookie,
        "/api/model-services/conversation",
        "PUT",
        { modelIds: [model.id, unsupportedModel.id], defaultModelId: unsupportedModel.id },
      );
      const requestsBeforeCapabilityFailure = upstream.requests.length;
      const capabilityError = await runPromptExpectError(
        client,
        "cm-native-capability-error",
        "this must not reach the provider",
      );
      assert(
        String(capabilityError.message).includes("toolCalls"),
        `capability error message ${JSON.stringify(capabilityError.message)}`,
      );
      assert(
        capabilityError.errorInfo?.code === "native_runtime_capability_error",
        `capability error code ${JSON.stringify(capabilityError.errorInfo)}`,
      );
      assert(capabilityError.errorInfo?.retryable === false, "capability error must not be retryable");
      assert(capabilityError.errorInfo?.needsReset === false, "capability error must not require reset");
      assert(
        upstream.requests.length === requestsBeforeCapabilityFailure,
        "unsupported tool calls reached the provider",
      );
      let capabilityQueue = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        capabilityQueue = stateRow(
          pair.rustStateDir,
          "SELECT status FROM prompt_queue WHERE client_message_id = ?",
          "cm-native-capability-error",
        );
        if (capabilityQueue?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        capabilityQueue?.status === "failed",
        `capability prompt_queue status ${capabilityQueue?.status}`,
      );
      console.log("ws native runtime conformance: ok");
    } finally {
      client.close();
    }
  } catch (error) {
    console.error("--- node output ---\n" + pair.nodeOutput());
    console.error("--- rust output ---\n" + pair.rustOutput());
    throw error;
  } finally {
    await pair.stop();
    await upstream.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
