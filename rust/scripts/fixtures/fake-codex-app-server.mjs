#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const logPath = process.env.ADS_APP_SERVER_PROBE_LOG;
if (!logPath) throw new Error("ADS_APP_SERVER_PROBE_LOG is required");
const simple = process.env.ADS_APP_SERVER_PROBE_SIMPLE === "1";
const responseText = process.env.ADS_APP_SERVER_PROBE_RESPONSE || "conformance done";
const responseDeltaParts = process.env.ADS_APP_SERVER_PROBE_DELTA_PARTS
  ? JSON.parse(process.env.ADS_APP_SERVER_PROBE_DELTA_PARTS)
  : [responseText];

const pending = new Map();
let turnNumber = 0;

function log(message) {
  fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}

function write(message) {
  log({ direction: "outbound", ...message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function serverRequest(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

async function runTurn() {
  const turn = String(++turnNumber);
  notify("thread/started", { thread: { id: "thread-1" } });
  notify("turn/started", { threadId: "thread-1", turn: { id: `turn-${turn}` } });
  if (!simple) {
    await serverRequest(`approval-command-${turn}`, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: `turn-${turn}`,
      itemId: `command-${turn}`,
      command: "rm -f state.db",
    });
    await serverRequest(`approval-file-${turn}`, "item/fileChange/requestApproval", {
      threadId: "thread-1",
      turnId: `turn-${turn}`,
      itemId: `file-${turn}`,
    });
    await serverRequest(`builtin-review-first-${turn}`, "item/tool/call", {
      threadId: "thread-1",
      turnId: `turn-${turn}`,
      callId: `review-${turn}`,
      tool: "review_action",
      arguments: {},
    });
    await serverRequest(`builtin-review-replay-${turn}`, "item/tool/call", {
      threadId: "thread-1",
      turnId: `turn-${turn}`,
      callId: `review-${turn}`,
      tool: "review_action",
      arguments: {},
    });
    for (const [event, item] of [
      ["item/started", { type: "fileChange", id: `file-${turn}`, changes: [{ kind: "modify", path: "src/lib.rs" }] }],
      ["item/completed", { type: "fileChange", id: `file-${turn}`, changes: [{ kind: "modify", path: "src/lib.rs" }] }],
      ["item/started", { type: "dynamicToolCall", id: `tool-${turn}`, tool: "review_action", status: "in_progress" }],
      ["item/completed", { type: "dynamicToolCall", id: `tool-${turn}`, tool: "review_action", status: "completed" }],
    ]) {
      notify(event, { threadId: "thread-1", turnId: `turn-${turn}`, item });
    }
  }
  for (const delta of responseDeltaParts) {
    notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: `turn-${turn}`,
      itemId: `message-${turn}`,
      delta,
    });
  }
  notify("item/completed", {
    threadId: "thread-1",
    turnId: `turn-${turn}`,
    item: { type: "agentMessage", id: `message-${turn}`, text: responseText },
  });
  notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: `turn-${turn}`, status: "completed" },
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log({ direction: "inbound", ...message });
  if (message.method) {
    switch (message.method) {
      case "initialize":
        response(message.id, {
          userAgent: "fake-codex-conformance",
          codexHome: process.cwd(),
          platformFamily: "unix",
          platformOs: "linux",
        });
        break;
      case "thread/start":
        response(message.id, {
          thread: { id: "thread-1" },
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          approvalPolicy: "untrusted",
        });
        break;
      case "thread/resume":
        response(message.id, {
          thread: { id: message.params?.threadId ?? "thread-1" },
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          approvalPolicy: "untrusted",
        });
        break;
      case "turn/start":
        response(message.id, {});
        void runTurn().catch((failure) => {
          process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
        });
        break;
      default:
        if (message.id === undefined) break;
        error(message.id, -32601, `unsupported method ${message.method}`);
    }
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
