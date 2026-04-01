import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";

import type { ReviewArtifact, ReviewStore } from "../../server/tasks/reviewStore.js";
import type { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import {
  createReviewerArtifact,
  publishReviewerPromptResult,
} from "../../server/web/server/ws/reviewerPromptArtifact.js";

describe("web/ws/reviewerPromptArtifact", () => {
  it("creates a reviewer artifact with the previous artifact id and summarized output", () => {
    const calls: Array<{ input: Record<string, unknown>; now: number }> = [];
    const createdArtifact = {
      id: "art-new",
      taskId: "task-1",
      snapshotId: "snap-1",
      queueItemId: null,
      scope: "reviewer",
      historyKey: "hk",
      promptText: "Explain this diff",
      responseText: "Paragraph one.\n\nParagraph two.",
      summaryText: "Paragraph one.",
      verdict: "analysis",
      priorArtifactId: "art-prev",
      createdAt: 123,
    } satisfies ReviewArtifact;
    const reviewStore: Pick<ReviewStore, "getLatestArtifact" | "createArtifact"> = {
      getLatestArtifact: () =>
        ({
          id: "art-prev",
          taskId: "task-1",
          snapshotId: "snap-1",
          queueItemId: null,
          scope: "reviewer",
          historyKey: "hk",
          promptText: "",
          responseText: "",
          summaryText: "",
          verdict: "analysis",
          priorArtifactId: null,
          createdAt: 1,
        }) satisfies ReviewArtifact,
      createArtifact: (input, now) => {
        calls.push({ input: input as Record<string, unknown>, now });
        return createdArtifact;
      },
    };

    const artifact = createReviewerArtifact({
      reviewStore,
      snapshot: { id: "snap-1", taskId: "task-1" },
      historyKey: "hk",
      inputToSend: [{ type: "text", text: "Explain this diff" }],
      output: "Paragraph one.\n\nParagraph two.",
      now: 123,
    });

    assert.equal(artifact, createdArtifact);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.now, 123);
    assert.deepEqual(calls[0]?.input, {
      taskId: "task-1",
      snapshotId: "snap-1",
      scope: "reviewer",
      historyKey: "hk",
      promptText: "Explain this diff",
      responseText: "Paragraph one.\n\nParagraph two.",
      summaryText: "Paragraph one.",
      verdict: "analysis",
      priorArtifactId: "art-prev",
    });
  });

  it("publishes reviewer output, reviewer artifact summary, logs output, and updates history", () => {
    const sent: unknown[] = [];
    const attachedThreadIds: Array<string | undefined> = [];
    const loggedOutput: string[] = [];
    const workspaceStateCalls: Array<{ ws: unknown; workspaceRoot: string }> = [];
    const historyStore = new HistoryStore({ namespace: "test-reviewer-artifact", maxEntriesPerSession: 20 });
    const artifact = {
      id: "art-new",
      taskId: "task-1",
      snapshotId: "snap-1",
      queueItemId: null,
      scope: "reviewer",
      historyKey: "hk",
      promptText: "Explain this diff",
      responseText: "Looks good",
      summaryText: "Looks good",
      verdict: "analysis",
      priorArtifactId: null,
      createdAt: 123,
    } satisfies ReviewArtifact;
    const ws = { id: "ws-1" } as unknown as WebSocket;
    const effectiveState: ReturnType<SessionManager["getEffectiveState"]> = {
      model: "gpt",
      modelReasoningEffort: "high",
      activeAgentId: "codex",
    };

    try {
      publishReviewerPromptResult({
        output: "Looks good",
        threadId: "thread-1",
        effectiveState,
        rotationNotice: "rotated",
        artifact,
        sendToChat: (payload) => sent.push(payload),
        sessionLogger: {
          logInput: () => {},
          logOutput: (text) => loggedOutput.push(text),
          logError: () => {},
          logEvent: () => {},
          attachThreadId: (threadId) => attachedThreadIds.push(threadId),
        },
        historyStore,
        historyKey: "hk",
        sendWorkspaceState: (socket, workspaceRoot) => workspaceStateCalls.push({ ws: socket, workspaceRoot }),
        ws,
        workspaceRoot: "/tmp/reviewer",
      });

      assert.deepEqual(sent, [
        {
          type: "result",
          ok: true,
          output: "Looks good",
          threadId: "thread-1",
          effectiveModel: "gpt",
          effectiveModelReasoningEffort: "high",
          activeAgentId: "codex",
          notice: "rotated",
        },
        {
          type: "reviewer_artifact",
          artifact: {
            id: "art-new",
            taskId: "task-1",
            snapshotId: "snap-1",
            queueItemId: null,
            scope: "reviewer",
            summaryText: "Looks good",
            verdict: "analysis",
            priorArtifactId: null,
            createdAt: 123,
          },
        },
      ]);
      assert.deepEqual(attachedThreadIds, ["thread-1"]);
      assert.deepEqual(loggedOutput, ["Looks good"]);
      assert.equal(historyStore.get("hk").at(-1)?.text, "Looks good");
      assert.deepEqual(workspaceStateCalls, [{ ws, workspaceRoot: "/tmp/reviewer" }]);
    } finally {
      historyStore.clear("hk");
    }
  });
});
