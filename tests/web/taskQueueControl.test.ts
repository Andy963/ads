import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pauseQueueInManualMode, startQueueInAllMode } from "../../server/web/taskQueue/control.js";

describe("web/taskQueue/control", () => {
  it("starts queue in all mode", () => {
    const calls: string[] = [];
    const ctx = {
      queueRunning: false,
      runController: {
        setModeAll() {
          calls.push("setModeAll");
        },
        setModeManual() {
          calls.push("setModeManual");
        },
      },
      taskQueue: {
        resume() {
          calls.push("resume");
        },
        pause(reason: string) {
          calls.push(`pause:${reason}`);
        },
      },
    };

    const result = startQueueInAllMode(ctx);

    assert.equal(result, ctx);
    assert.equal(ctx.queueRunning, true);
    assert.deepEqual(calls, ["setModeAll", "resume"]);
  });

  it("pauses queue in manual mode with explicit reason", () => {
    const calls: string[] = [];
    const ctx = {
      queueRunning: true,
      runController: {
        setModeAll() {
          calls.push("setModeAll");
        },
        setModeManual() {
          calls.push("setModeManual");
        },
      },
      taskQueue: {
        resume() {
          calls.push("resume");
        },
        pause(reason: string) {
          calls.push(`pause:${reason}`);
        },
      },
    };

    const result = pauseQueueInManualMode(ctx, "manual");

    assert.equal(result, ctx);
    assert.equal(ctx.queueRunning, false);
    assert.deepEqual(calls, ["setModeManual", "pause:manual"]);
  });
});
