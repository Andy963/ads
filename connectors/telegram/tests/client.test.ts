import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { AdsCoreClient } from "../src/client/adsClient.js";

type PromptMessage = {
  type: string;
  payload?: {
    channel?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  };
  client_message_id?: string;
};

describe("AdsCoreClient", () => {
  it("connects and sends turns with channel=telegram", async () => {
    const receivedMessages: PromptMessage[] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP address");
    }
    const port = address.port;

    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        receivedMessages.push(msg as PromptMessage);
        if (msg.type === "prompt") {
          // Match the Core WebSocket terminal frame.
          ws.send(JSON.stringify({
            type: "result",
            ok: true,
            output: "Hello from ADS Core",
            clientMessageId: msg.client_message_id,
          }));
        }
      });
    });

    const client = new AdsCoreClient({
      coreUrl: `http://127.0.0.1:${port}`,
      coreWsUrl: `ws://127.0.0.1:${port}`,
      sessionId: "telegram",
      chatSessionId: "chat-42",
    });

    await client.connect();
    const { finalResponse } = await client.sendPrompt({
      text: "Hello world",
      channel: "telegram",
      metadata: { telegramChatId: "42" },
      clientMessageId: "test-message-1",
    });

    const result = await finalResponse;
    assert.equal(result, "Hello from ADS Core");
    assert.equal(receivedMessages.length, 1);
    assert.equal(receivedMessages[0].type, "prompt");
    assert.equal(receivedMessages[0]?.payload?.channel, "telegram");
    assert.equal(receivedMessages[0]?.payload?.text, "Hello world");
    assert.equal(receivedMessages[0]?.payload?.metadata?.telegramChatId, "42");
    assert.equal(receivedMessages[0]?.client_message_id, "test-message-1");

    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("uses an isolated Core chat session for each Telegram chat", async () => {
    const protocols: string[][] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP address");
    }

    wss.on("connection", (_ws, request) => {
      const header = request.headers["sec-websocket-protocol"];
      protocols.push(String(header ?? "").split(",").map((value) => value.trim()));
    });

    const connect = async (chatSessionId: string) => {
      const client = new AdsCoreClient({
        coreUrl: `http://127.0.0.1:${address.port}`,
        coreWsUrl: `ws://127.0.0.1:${address.port}`,
        sessionId: "telegram",
        chatSessionId,
      });
      await client.connect();
      client.close();
    };

    await connect("chat-100");
    await connect("chat-200");
    assert.deepEqual(protocols, [
      ["ads-v1", "ads-session.telegram", "ads-chat.chat-100"],
      ["ads-v1", "ads-session.telegram", "ads-chat.chat-200"],
    ]);

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("reconnects a notification client after the Core socket closes", async () => {
    let connections = 0;
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a TCP address");
    }

    let firstSocket: import("ws").WebSocket | null = null;
    const reconnected = new Promise<void>((resolve) => {
      wss.on("connection", (ws) => {
        connections += 1;
        if (connections === 1) {
          firstSocket = ws;
        } else {
          resolve();
        }
      });
    });

    const client = new AdsCoreClient({
      coreUrl: `http://127.0.0.1:${address.port}`,
      coreWsUrl: `ws://127.0.0.1:${address.port}`,
      autoReconnect: true,
      reconnectIntervalMs: 10,
    });
    await client.connect();
    firstSocket?.close();

    await Promise.race([
      reconnected,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("reconnect timeout")), 1_000)),
    ]);

    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("sends a per-chat model override and tracks the Core acknowledgement", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP address");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string; client_message_id?: string; payload?: { model?: string; model_reasoning_effort?: string } };
        if (message.type === "model_override") {
          ws.send(JSON.stringify({
            type: "result",
            kind: "model_override",
            ok: true,
            model: message.payload?.model,
            model_reasoning_effort: message.payload?.model_reasoning_effort,
            client_message_id: message.client_message_id,
          }));
        }
      });
    });

    const client = new AdsCoreClient({
      coreUrl: `http://127.0.0.1:${address.port}`,
      coreWsUrl: `ws://127.0.0.1:${address.port}`,
      sessionId: "telegram",
      chatSessionId: "chat-42",
    });
    const state = await client.setModel("gemini-3.8-flash-high", "xhigh");
    assert.deepEqual(state, { model: "gemini-3.8-flash-high", reasoningEffort: "xhigh" });
    assert.deepEqual(client.getModelState(), state);
    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("waits for the Core welcome frame before reporting the active model", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("WebSocket test server did not expose a TCP address");
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({
        type: "welcome",
        effectiveModel: "gpt-5.6-sol",
        effectiveModelReasoningEffort: "high",
      }));
    });

    const client = new AdsCoreClient({
      coreUrl: `http://127.0.0.1:${address.port}`,
      coreWsUrl: `ws://127.0.0.1:${address.port}`,
    });
    await client.connect();
    await client.waitForWelcome();
    assert.deepEqual(client.getModelState(), { model: "gpt-5.6-sol", reasoningEffort: "high" });
    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("loads only enabled model options from the Core API", async () => {
    const server = createServer((req, res) => {
      assert.equal(req.headers.authorization, "Bearer connector-token");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([
        { id: "one", modelId: "gpt-5.6-sol", displayName: "Sol", provider: "openai", isEnabled: true, isDefault: true, configJson: null },
        { id: "two", modelId: "disabled", displayName: "Disabled", provider: "openai", isEnabled: false, isDefault: false, configJson: null },
      ]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
    const client = new AdsCoreClient({
      coreUrl: `http://127.0.0.1:${address.port}`,
      coreWsUrl: `ws://127.0.0.1:${address.port}`,
      token: "connector-token",
    });
    const models = await client.getModels();
    assert.deepEqual(models.map((model) => model.modelId), ["gpt-5.6-sol"]);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
