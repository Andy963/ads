import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGoalControlMessage } from "../../server/web/server/ws/handleGoalControl.js";
import type { WsMessage } from "../../server/web/server/ws/schema.js";

const noopLogger = { info: () => {}, warn: () => {} };

describe("WS goal control handler", () => {
  it("returns false for non-goal message types", async () => {
    const handled = await handleGoalControlMessage({
      parsed: { type: "prompt" } as WsMessage,
      currentCwd: "/tmp",
      sessionManager: {} as any,
      sendJson: () => {},
      logger: noopLogger,
    });
    assert.equal(handled, false);
  });

  it("rejects retired goal controls without resolving a task context", async () => {
    const sent: unknown[] = [];
    const result = await handleGoalControlMessage({
      parsed: { type: "goal:pause", payload: { taskId: "legacy-task" } } as WsMessage,
      currentCwd: "/tmp",
      sessionManager: {} as any,
      sendJson: (payload) => sent.push(payload),
      logger: noopLogger,
    });

    assert.equal(result, true);
    assert.deepEqual(sent, [
      { type: "error", message: "Goal controls are no longer supported; use the active chat lane." },
    ]);
  });
});
