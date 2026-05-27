import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWsLaneResources } from "../../server/web/server/ws/laneResources.js";

describe("web/ws/laneResources", () => {
  it("selects worker resources for the main chat lane", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      plannerSessionManager: { id: "planner-session" },
      getWorkspaceLock: () => "worker-lock",
      getPlannerWorkspaceLock: () => "planner-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      plannerHistoryStore: { id: "planner-history" },
    };

    const resolved = resolveWsLaneResources({
      chatSessionId: "main",
      sessions: sessions as any,
      history: history as any,
    });

    assert.equal(resolved.isPlannerChat, false);
    assert.equal((resolved.sessionManager as any).id, "worker-session");
    assert.equal((resolved.historyStore as any).id, "worker-history");
    assert.equal(resolved.getWorkspaceLock("/tmp"), "worker-lock");
  });

  it("selects planner resources for planner and worker resources for other lanes", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      plannerSessionManager: { id: "planner-session" },
      getWorkspaceLock: () => "worker-lock",
      getPlannerWorkspaceLock: () => "planner-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      plannerHistoryStore: { id: "planner-history" },
    };

    const planner = resolveWsLaneResources({
      chatSessionId: "planner",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(planner.isPlannerChat, true);
    assert.equal((planner.sessionManager as any).id, "planner-session");
    assert.equal((planner.historyStore as any).id, "planner-history");
    assert.equal(planner.getWorkspaceLock("/tmp"), "planner-lock");

    const other = resolveWsLaneResources({
      chatSessionId: "custom-worker",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(other.isPlannerChat, false);
    assert.equal((other.sessionManager as any).id, "worker-session");
    assert.equal((other.historyStore as any).id, "worker-history");
    assert.equal(other.getWorkspaceLock("/tmp"), "worker-lock");
  });
});
