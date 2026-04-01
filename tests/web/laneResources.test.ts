import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWsLaneResources } from "../../server/web/server/ws/laneResources.js";

describe("web/ws/laneResources", () => {
  it("selects worker resources for the main chat lane", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      plannerSessionManager: { id: "planner-session" },
      reviewerSessionManager: { id: "reviewer-session" },
      getWorkspaceLock: () => "worker-lock",
      getPlannerWorkspaceLock: () => "planner-lock",
      getReviewerWorkspaceLock: () => "reviewer-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      plannerHistoryStore: { id: "planner-history" },
      reviewerHistoryStore: { id: "reviewer-history" },
    };

    const resolved = resolveWsLaneResources({
      chatSessionId: "main",
      sessions: sessions as any,
      history: history as any,
    });

    assert.equal(resolved.isPlannerChat, false);
    assert.equal(resolved.isReviewerChat, false);
    assert.equal((resolved.sessionManager as any).id, "worker-session");
    assert.equal((resolved.historyStore as any).id, "worker-history");
    assert.equal(resolved.getWorkspaceLock("/tmp"), "worker-lock");
  });

  it("selects planner and reviewer resources for their dedicated lanes", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      plannerSessionManager: { id: "planner-session" },
      reviewerSessionManager: { id: "reviewer-session" },
      getWorkspaceLock: () => "worker-lock",
      getPlannerWorkspaceLock: () => "planner-lock",
      getReviewerWorkspaceLock: () => "reviewer-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      plannerHistoryStore: { id: "planner-history" },
      reviewerHistoryStore: { id: "reviewer-history" },
    };

    const planner = resolveWsLaneResources({
      chatSessionId: "planner",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(planner.isPlannerChat, true);
    assert.equal(planner.isReviewerChat, false);
    assert.equal((planner.sessionManager as any).id, "planner-session");
    assert.equal((planner.historyStore as any).id, "planner-history");
    assert.equal(planner.getWorkspaceLock("/tmp"), "planner-lock");

    const reviewer = resolveWsLaneResources({
      chatSessionId: "reviewer",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(reviewer.isPlannerChat, false);
    assert.equal(reviewer.isReviewerChat, true);
    assert.equal((reviewer.sessionManager as any).id, "reviewer-session");
    assert.equal((reviewer.historyStore as any).id, "reviewer-history");
    assert.equal(reviewer.getWorkspaceLock("/tmp"), "reviewer-lock");
  });
});
