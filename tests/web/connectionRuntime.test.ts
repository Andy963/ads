import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { abortInFlightHistory, broadcastJsonToHistoryKey, cleanupClosedConnection } from "../../server/web/server/ws/connectionRuntime.js";

describe("web/ws/connectionRuntime", () => {
  it("broadcasts payloads only to sockets bound to the target history key", () => {
    const wsA = {} as any;
    const wsB = {} as any;
    const sent: Array<{ ws: unknown; payload: unknown }> = [];

    broadcastJsonToHistoryKey({
      clientMetaByWs: new Map([
        [wsA, { historyKey: "h1" } as any],
        [wsB, { historyKey: "h2" } as any],
      ]),
      historyKey: "h1",
      payload: { type: "result" },
      sendJson: (ws, payload) => sent.push({ ws, payload }),
    });

    assert.deepEqual(sent, [{ ws: wsA, payload: { type: "result" } }]);
  });

  it("aborts in-flight work when present", () => {
    let aborted = 0;
    const controller = new AbortController();
    controller.abort = () => {
      aborted += 1;
    };
    assert.equal(
      abortInFlightHistory({
        interruptControllers: new Map([["h1", controller]]),
        historyKey: "h1",
      }),
      true,
    );
    assert.equal(aborted, 1);
  });

  it("cleans up closed sockets, aborts pending work, and logs disconnect details", () => {
    const ws = {} as any;
    let aborted = 0;
    const controller = new AbortController();
    controller.abort = () => {
      aborted += 1;
    };
    const clients = new Set([ws]);
    const clientMetaByWs = new Map([
      [
        ws,
        {
          historyKey: "h1",
          connectionId: "c1",
        } as any,
      ],
    ]);
    const interruptControllers = new Map([["h1", controller]]);
    const logs: string[] = [];

    cleanupClosedConnection({
      ws,
      code: 1000,
      reason: Buffer.from("bye"),
      sessionId: "session-1",
      userId: 7,
      clients,
      clientMetaByWs,
      interruptControllers,
      logger: {
        info: (message) => logs.push(message),
        warn: () => {},
        debug: () => {},
      },
    });

    assert.equal(aborted, 1);
    assert.equal(clients.has(ws), false);
    assert.equal(clientMetaByWs.has(ws), false);
    assert.equal(interruptControllers.has("h1"), false);
    assert.match(logs[0]!, /client disconnected conn=c1 session=session-1 user=7 history=h1 code=1000 reason=bye/);
  });
});
