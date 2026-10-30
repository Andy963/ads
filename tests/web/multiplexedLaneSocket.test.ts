import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type WebSocket from "ws";
import type { IncomingMessage } from "node:http";

import { createMultiplexedLaneRequest, createMultiplexedLaneSocket } from "../../server/web/server/ws/multiplexedLaneSocket.js";

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

describe("multiplexed WebSocket lanes", () => {
  it("routes inbound and outbound frames by lane while sharing one physical socket", () => {
    const physicalSocket = new FakeWebSocket();
    const subscribedChatSessionIds = ["main", "acopilot"];
    const actionsSocket = createMultiplexedLaneSocket({
      socket: physicalSocket as unknown as WebSocket,
      chatSessionId: "main",
      subscribedChatSessionIds,
    });
    const acopilotSocket = createMultiplexedLaneSocket({
      socket: physicalSocket as unknown as WebSocket,
      chatSessionId: "acopilot",
      subscribedChatSessionIds,
    });
    const delivered: string[] = [];
    actionsSocket.on("message", (data: Buffer) => delivered.push(`actions:${JSON.parse(data.toString()).type}`));
    acopilotSocket.on("message", (data: Buffer) => delivered.push(`acopilot:${JSON.parse(data.toString()).type}`));

    physicalSocket.emit("message", Buffer.from(JSON.stringify({ type: "delta", chat_session_id: "main" })));
    physicalSocket.emit("message", Buffer.from(JSON.stringify({ type: "delta", chatSessionId: "acopilot" })));

    assert.deepEqual(delivered, ["actions:delta", "acopilot:delta"]);
    assert.equal(actionsSocket.physicalSocket, physicalSocket);
    assert.equal(acopilotSocket.physicalSocket, physicalSocket);

    actionsSocket.send(JSON.stringify({ type: "welcome", chatSessionId: "main" }));
    acopilotSocket.send(JSON.stringify({ type: "welcome", chatSessionId: "acopilot" }));
    assert.deepEqual(physicalSocket.sent.map((frame) => JSON.parse(frame)), [
      { type: "welcome", chatSessionId: "main", subscribedChatSessionIds },
      { type: "welcome", chatSessionId: "acopilot", subscribedChatSessionIds },
    ]);
  });

  it("moves a switched lane to its new chat session without disturbing its sibling", () => {
    const physicalSocket = new FakeWebSocket();
    const subscribedChatSessionIds = ["main", "acopilot"];
    const actionsSocket = createMultiplexedLaneSocket({
      socket: physicalSocket as unknown as WebSocket,
      chatSessionId: "main",
      subscribedChatSessionIds,
    });
    const acopilotSocket = createMultiplexedLaneSocket({
      socket: physicalSocket as unknown as WebSocket,
      chatSessionId: "acopilot",
      subscribedChatSessionIds,
    });
    const delivered: string[] = [];
    actionsSocket.on("message", (data: Buffer) => delivered.push(`actions:${JSON.parse(data.toString()).type}`));
    acopilotSocket.on("message", (data: Buffer) => delivered.push(`acopilot:${JSON.parse(data.toString()).type}`));

    physicalSocket.emit("message", Buffer.from(JSON.stringify({
      type: "switch_chat_session",
      chat_session_id: "main",
      payload: { chatSessionId: "work" },
    })));
    actionsSocket.send(JSON.stringify({ type: "welcome", chatSessionId: "work" }));
    physicalSocket.emit("message", Buffer.from(JSON.stringify({ type: "delta", chat_session_id: "work" })));
    physicalSocket.emit("message", Buffer.from(JSON.stringify({ type: "delta", chat_session_id: "acopilot" })));
    physicalSocket.emit("message", Buffer.from(JSON.stringify({ type: "delta", chat_session_id: "main" })));

    assert.deepEqual(delivered, ["actions:switch_chat_session", "actions:delta", "acopilot:delta"]);
    assert.deepEqual(JSON.parse(physicalSocket.sent[0]!), {
      type: "welcome",
      chatSessionId: "work",
      subscribedChatSessionIds: ["work", "acopilot"],
    });
  });

  it("keeps bootstrap cursors scoped to the lane request", () => {
    const request = {
      headers: { "sec-websocket-protocol": "ads-v1, ads-chat.main, ads-chat.acopilot" },
      url: "/ws?afterSeq.main=12&laneGeneration.main=4&afterSeq.acopilot=8&laneGeneration.acopilot=2",
    } as unknown as IncomingMessage;

    const actionsRequest = createMultiplexedLaneRequest({
      request,
      protocols: ["ads-v1", "ads-chat.main", "ads-chat.acopilot"],
      chatSessionId: "main",
    });
    const acopilotRequest = createMultiplexedLaneRequest({
      request,
      protocols: ["ads-v1", "ads-chat.main", "ads-chat.acopilot"],
      chatSessionId: "acopilot",
    });

    assert.equal(new URL(actionsRequest.url ?? "", "http://localhost").searchParams.get("afterSeq"), "12");
    assert.equal(new URL(actionsRequest.url ?? "", "http://localhost").searchParams.get("laneGeneration"), "4");
    assert.equal(new URL(acopilotRequest.url ?? "", "http://localhost").searchParams.get("afterSeq"), "8");
    assert.equal(new URL(acopilotRequest.url ?? "", "http://localhost").searchParams.get("laneGeneration"), "2");
    assert.equal(actionsRequest.headers["sec-websocket-protocol"], "ads-v1, ads-chat.main");
    assert.equal(acopilotRequest.headers["sec-websocket-protocol"], "ads-v1, ads-chat.acopilot");
  });
});
