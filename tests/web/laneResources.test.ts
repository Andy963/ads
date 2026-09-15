import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWsLaneResources } from "../../server/web/server/ws/laneResources.js";

describe("web/ws/laneResources", () => {
  it("selects worker resources for the main chat lane", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      advisorSessionManager: { id: "advisor-session" },
      getWorkspaceLock: () => "worker-lock",
      getAdvisorWorkspaceLock: () => "advisor-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      advisorHistoryStore: { id: "advisor-history" },
    };

    const resolved = resolveWsLaneResources({
      chatSessionId: "main",
      sessions: sessions as any,
      history: history as any,
    });

    assert.equal(resolved.isAdvisorChat, false);
    assert.equal((resolved.sessionManager as any).id, "worker-session");
    assert.equal((resolved.historyStore as any).id, "worker-history");
    assert.equal(resolved.getWorkspaceLock("/tmp"), "worker-lock");
  });

  it("selects advisor resources for advisor and worker resources for other lanes", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      advisorSessionManager: { id: "advisor-session" },
      getWorkspaceLock: () => "worker-lock",
      getAdvisorWorkspaceLock: () => "advisor-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      advisorHistoryStore: { id: "advisor-history" },
    };

    const advisor = resolveWsLaneResources({
      chatSessionId: "advisor",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(advisor.isAdvisorChat, true);
    assert.equal((advisor.sessionManager as any).id, "advisor-session");
    assert.equal((advisor.historyStore as any).id, "advisor-history");
    assert.equal(advisor.getWorkspaceLock("/tmp"), "advisor-lock");

    const other = resolveWsLaneResources({
      chatSessionId: "custom-worker",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(other.isAdvisorChat, false);
    assert.equal((other.sessionManager as any).id, "worker-session");
    assert.equal((other.historyStore as any).id, "worker-history");
    assert.equal(other.getWorkspaceLock("/tmp"), "worker-lock");
  });
});
