import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleImmediateWsMessage, parseIncomingWsEnvelope } from "../../server/web/server/ws/messageIntake.js";

describe("web/ws/messageIntake", () => {
  it("parses valid incoming messages and normalizes client ids", () => {
    const envelope = parseIncomingWsEnvelope({
      data: Buffer.from(JSON.stringify({ type: "command", payload: "echo hi", client_message_id: "  m1  " })),
      lastReceivedAt: 5,
      now: 10,
    });

    assert.deepEqual(envelope, {
      ok: true,
      parsed: { type: "command", payload: "echo hi", client_message_id: "  m1  " },
      receivedAt: 10,
      nextReceivedAt: 10,
      clientMessageId: "m1",
    });
  });

  it("returns protocol errors for invalid payloads", () => {
    assert.deepEqual(parseIncomingWsEnvelope({ data: Buffer.from("{"), lastReceivedAt: 1, now: 2 }), {
      ok: false,
      nextReceivedAt: 2,
      errorMessage: "Invalid JSON message",
    });
  });

  it("handles ping/pong/interrupt control messages immediately", () => {
    const sent: unknown[] = [];
    let aborted = 0;

    assert.equal(
      handleImmediateWsMessage({
        parsed: { type: "ping" },
        receivedAt: 7,
        abortInFlight: () => false,
        sendJson: (payload) => sent.push(payload),
      }),
      true,
    );
    assert.equal(
      handleImmediateWsMessage({
        parsed: { type: "interrupt" },
        receivedAt: 8,
        abortInFlight: () => {
          aborted += 1;
          return false;
        },
        sendJson: (payload) => sent.push(payload),
      }),
      true,
    );
    assert.equal(
      handleImmediateWsMessage({
        parsed: { type: "pong" },
        receivedAt: 9,
        abortInFlight: () => true,
        sendJson: (payload) => sent.push(payload),
      }),
      true,
    );
    assert.equal(aborted, 1);
    assert.deepEqual(sent, [
      { type: "pong", ts: 7 },
      { type: "error", message: "当前没有正在执行的任务" },
    ]);
  });
});
