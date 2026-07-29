import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  abortInFlightHistory,
  broadcastJsonToHistoryKey,
  cleanupClosedConnection,
  closeConnectionsForHistoryKey,
  closeConnectionsForSession,
} from "../../server/web/server/ws/connectionRuntime.js";

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

  it("can exclude the source socket from a history-key broadcast", () => {
    const wsA = {} as any;
    const wsB = {} as any;
    const sent: Array<{ ws: unknown; payload: unknown }> = [];

    broadcastJsonToHistoryKey({
      clientMetaByWs: new Map([
        [wsA, { historyKey: "h1" } as any],
        [wsB, { historyKey: "h1" } as any],
      ]),
      historyKey: "h1",
      payload: { type: "history", items: [] },
      sendJson: (ws, payload) => sent.push({ ws, payload }),
      excludeWs: wsA,
    });

    assert.deepEqual(sent, [{ ws: wsB, payload: { type: "history", items: [] } }]);
  });

  it("closes every socket for a history key when durable sync fails", () => {
    const closed: Array<{ socket: string; code: number; reason: string }> = [];
    const wsA = { close: (code: number, reason: string) => closed.push({ socket: "a", code, reason }) } as any;
    const wsB = { close: (code: number, reason: string) => closed.push({ socket: "b", code, reason }) } as any;
    const wsOther = { close: (code: number, reason: string) => closed.push({ socket: "other", code, reason }) } as any;

    closeConnectionsForHistoryKey({
      clientMetaByWs: new Map([
        [wsA, { historyKey: "h1" } as any],
        [wsB, { historyKey: "h1" } as any],
        [wsOther, { historyKey: "h2" } as any],
      ]),
      historyKey: "h1",
    });

    assert.deepEqual(closed, [
      { socket: "a", code: 1011, reason: "sync persistence failed" },
      { socket: "b", code: 1011, reason: "sync persistence failed" },
    ]);
  });

  it("closes every lane in an affected authenticated session", () => {
    const closed: string[] = [];
    const worker = { close: () => closed.push("worker") } as any;
    const planner = { close: () => closed.push("planner") } as any;
    const otherSession = { close: () => closed.push("other-session") } as any;
    const otherUser = { close: () => closed.push("other-user") } as any;

    closeConnectionsForSession({
      clientMetaByWs: new Map([
        [worker, { authUserId: "u1", sessionId: "s1", chatSessionId: "main" } as any],
        [planner, { authUserId: "u1", sessionId: "s1", chatSessionId: "planner" } as any],
        [otherSession, { authUserId: "u1", sessionId: "s2", chatSessionId: "main" } as any],
        [otherUser, { authUserId: "u2", sessionId: "s1", chatSessionId: "main" } as any],
      ]),
      authUserId: "u1",
      sessionId: "s1",
    });

    assert.deepEqual(closed, ["worker", "planner"]);
  });

  it("aborts in-flight work when present", () => {
    let aborted = 0;
    const controller = new AbortController();
    const promptRunEpochs = new Map<string, number>([["h1", 1]]);
    controller.abort = () => {
      aborted += 1;
    };
    assert.equal(
      abortInFlightHistory({
        interruptControllers: new Map([["h1", controller]]),
        promptRunEpochs,
        historyKey: "h1",
      }),
      true,
    );
    assert.equal(aborted, 1);
    assert.equal(promptRunEpochs.get("h1"), 2);
  });

  it("cleans up closed sockets without aborting pending work", () => {
    const ws = {} as any;
    let aborted = 0;
    const controller = new AbortController();
    const promptRunEpochs = new Map<string, number>([["h1", 1]]);
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

    assert.equal(aborted, 0);
    assert.equal(clients.has(ws), false);
    assert.equal(clientMetaByWs.has(ws), false);
    assert.equal(interruptControllers.get("h1"), controller);
    assert.equal(promptRunEpochs.get("h1"), 1);
    assert.match(
      logs[0]!,
      /client disconnected conn=c1 session=session-1 user=7 history=h1 code=1000 reason=bye inFlight=true/,
    );
  });

  it("keeps in-flight work when another socket for the same history key remains connected", () => {
    const wsA = {} as any;
    const wsB = {} as any;
    let aborted = 0;
    const controller = new AbortController();
    const promptRunEpochs = new Map<string, number>([["h1", 1]]);
    controller.abort = () => {
      aborted += 1;
    };
    const clients = new Set([wsA, wsB]);
    const clientMetaByWs = new Map([
      [
        wsA,
        {
          historyKey: "h1",
          connectionId: "c1",
        } as any,
      ],
      [
        wsB,
        {
          historyKey: "h1",
          connectionId: "c2",
        } as any,
      ],
    ]);
    const interruptControllers = new Map([["h1", controller]]);

    cleanupClosedConnection({
      ws: wsA,
      code: 1000,
      reason: Buffer.alloc(0),
      sessionId: "session-1",
      userId: 7,
      clients,
      clientMetaByWs,
      interruptControllers,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
    });

    assert.equal(aborted, 0);
    assert.equal(clients.has(wsA), false);
    assert.equal(clientMetaByWs.has(wsA), false);
    assert.equal(interruptControllers.get("h1"), controller);
    assert.equal(promptRunEpochs.get("h1"), 1);
  });

  it("aborts in-flight work when authentication closes the connection", () => {
    const ws = {} as any;
    let aborted = 0;
    const controller = new AbortController();
    const promptRunEpochs = new Map<string, number>([["h1", 1]]);
    controller.abort = () => {
      aborted += 1;
    };
    const interruptControllers = new Map([["h1", controller]]);

    cleanupClosedConnection({
      ws,
      code: 4401,
      reason: Buffer.from("session expired"),
      sessionId: "session-1",
      userId: 7,
      clients: new Set([ws]),
      clientMetaByWs: new Map([
        [
          ws,
          {
            historyKey: "h1",
            connectionId: "c1",
          } as any,
        ],
      ]),
      interruptControllers,
      promptRunEpochs,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
    });

    assert.equal(aborted, 1);
    assert.equal(interruptControllers.has("h1"), false);
    assert.equal(promptRunEpochs.get("h1"), 2);
  });

  it("keeps in-flight work when an expired sibling connection closes", () => {
    const expiredWs = {} as any;
    const activeWs = {} as any;
    let aborted = 0;
    const controller = new AbortController();
    const promptRunEpochs = new Map<string, number>([["h1", 1]]);
    controller.abort = () => {
      aborted += 1;
    };
    const interruptControllers = new Map([["h1", controller]]);
    const clients = new Set([expiredWs, activeWs]);
    const clientMetaByWs = new Map([
      [expiredWs, { historyKey: "h1", connectionId: "expired" } as any],
      [activeWs, { historyKey: "h1", connectionId: "active" } as any],
    ]);

    cleanupClosedConnection({
      ws: expiredWs,
      code: 4401,
      reason: Buffer.from("session expired"),
      sessionId: "session-1",
      userId: 7,
      clients,
      clientMetaByWs,
      interruptControllers,
      promptRunEpochs,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
    });

    assert.equal(aborted, 0);
    assert.equal(clients.has(expiredWs), false);
    assert.equal(clients.has(activeWs), true);
    assert.equal(interruptControllers.get("h1"), controller);
    assert.equal(promptRunEpochs.get("h1"), 1);
  });
});
