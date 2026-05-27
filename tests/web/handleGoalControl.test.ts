import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGoalControlMessage } from "../../server/web/server/ws/handleGoalControl.js";
import type { TaskQueueContext } from "../../server/web/server/taskQueue/manager.js";
import type { WsMessage } from "../../server/web/server/ws/schema.js";

const noopLogger = { info: () => {}, warn: () => {} };

function makeTaskCtx(args: {
  task: any;
  adapter: any;
}): TaskQueueContext {
  const ctx: Partial<TaskQueueContext> = {
    workspaceRoot: "/tmp/ws",
    sessionId: "proj-session",
    taskStore: {
      getTask: (id: string) => (id === args.task.id ? args.task : null),
    } as unknown as TaskQueueContext["taskStore"],
    getTaskQueueOrchestrator: (_t: { id: string; goalMode?: boolean }) =>
      ({ getAdapter: (id: string) => (id === "codex" ? args.adapter : null) }) as any,
  };
  return ctx as TaskQueueContext;
}

describe("WS goal control handler", () => {
  it("returns false for non-goal message types", async () => {
    const handled = await handleGoalControlMessage({
      parsed: { type: "prompt" } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ({} as TaskQueueContext),
      sessionManager: {} as any,
      sendJson: () => {},
      logger: noopLogger,
    });
    assert.equal(handled, false);
  });

  it("errors when taskId is missing", async () => {
    const sent: any[] = [];
    await handleGoalControlMessage({
      parsed: { type: "goal:pause", payload: {} } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ({} as TaskQueueContext),
      sessionManager: {} as any,
      sendJson: (p) => sent.push(p),
      logger: noopLogger,
    });
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { type: string }).type, "error");
  });

  it("rejects non goal-mode tasks", async () => {
    const sent: any[] = [];
    const ctx = makeTaskCtx({ task: { id: "t1", goalMode: false }, adapter: null });
    await handleGoalControlMessage({
      parsed: { type: "goal:pause", payload: { taskId: "t1" } } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ctx,
      sessionManager: {} as any,
      sendJson: (p) => sent.push(p),
      logger: noopLogger,
    });
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]), /not in goal mode/);
  });

  it("calls setGoal status='paused' on goal:pause", async () => {
    const calls: any[] = [];
    const adapter = {
      setGoal: async (opts: any) => {
        calls.push({ method: "setGoal", opts });
        return {};
      },
    };
    const ctx = makeTaskCtx({ task: { id: "t1", goalMode: true }, adapter });
    const sent: any[] = [];
    await handleGoalControlMessage({
      parsed: { type: "goal:pause", payload: { taskId: "t1" } } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ctx,
      sessionManager: {} as any,
      sendJson: (p) => sent.push(p),
      logger: noopLogger,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.status, "paused");
    assert.equal((sent[0] as { ok: boolean }).ok, true);
  });

  it("calls setGoal status='active' on goal:resume", async () => {
    const calls: any[] = [];
    const adapter = {
      setGoal: async (opts: any) => {
        calls.push(opts);
        return {};
      },
    };
    const ctx = makeTaskCtx({ task: { id: "t1", goalMode: true }, adapter });
    await handleGoalControlMessage({
      parsed: { type: "goal:resume", payload: { taskId: "t1" } } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ctx,
      sessionManager: {} as any,
      sendJson: () => {},
      logger: noopLogger,
    });
    assert.equal(calls[0].status, "active");
  });

  it("calls clearGoal on goal:clear", async () => {
    let cleared = false;
    const adapter = {
      clearGoal: async () => {
        cleared = true;
      },
    };
    const ctx = makeTaskCtx({ task: { id: "t1", goalMode: true }, adapter });
    await handleGoalControlMessage({
      parsed: { type: "goal:clear", payload: { taskId: "t1" } } as WsMessage,
      currentCwd: "/tmp",
      ensureTaskContext: () => ctx,
      sessionManager: {} as any,
      sendJson: () => {},
      logger: noopLogger,
    });
    assert.equal(cleared, true);
  });
});
