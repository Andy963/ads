import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryStoreResumeTranscript,
  buildTaskResumeTranscript,
  loadTaskResumeConversationContext,
  selectMostRecentTaskResumeCandidate,
} from "../../server/web/server/ws/taskResumeConversation.js";

describe("web/ws/taskResumeConversation", () => {
  it("selects the most recent task by completed, started, or created timestamp", () => {
    const selected = selectMostRecentTaskResumeCandidate([
      {
        id: "older",
        title: "Older",
        prompt: "prompt",
        model: "gpt",
        status: "completed",
        priority: 0,
        queueOrder: 0,
        inheritContext: false,
        agentId: null,
        retryCount: 0,
        maxRetries: 0,
        reviewRequired: false,
        reviewStatus: "none",
        createdAt: 10,
        completedAt: 20,
      },
      {
        id: "newer",
        title: "Newer",
        prompt: "prompt",
        model: "gpt",
        status: "failed",
        priority: 0,
        queueOrder: 0,
        inheritContext: false,
        agentId: null,
        retryCount: 0,
        maxRetries: 0,
        reviewRequired: false,
        reviewStatus: "none",
        createdAt: 30,
      },
    ]);

    assert.equal(selected?.id, "newer");
  });

  it("builds transcript from user and assistant messages only", () => {
    const transcript = buildTaskResumeTranscript([
      {
        conversationId: "conv-1",
        role: "system",
        content: "ignored",
        createdAt: 1,
      },
      {
        conversationId: "conv-1",
        role: "user",
        content: "hello",
        createdAt: 2,
      },
      {
        conversationId: "conv-1",
        role: "assistant",
        content: "hi",
        createdAt: 3,
      },
    ]);

    assert.equal(transcript, "User: hello\nAssistant: hi");
  });

  it("builds transcript from lane history user and ai entries only", () => {
    const transcript = buildHistoryStoreResumeTranscript([
      { role: "status", text: "ignored", ts: 1 },
      { role: "user", text: "current question", ts: 2 },
      { role: "ai", text: "current answer", ts: 3 },
    ]);

    assert.equal(transcript, "User: current question\nAssistant: current answer");
  });

  it("loads the latest resumable task conversation and truncates long transcripts from the front", () => {
    const longAssistantReply = "x".repeat(10_100);
    const context = loadTaskResumeConversationContext({
      listTasks: ({ status }: { status?: string }) => {
        if (status === "completed") {
          return [
            {
              id: "task-1",
              title: "Recent task",
              prompt: "prompt",
              model: "gpt",
              status: "completed",
              priority: 0,
              queueOrder: 0,
              inheritContext: false,
              agentId: null,
              retryCount: 0,
              maxRetries: 0,
              reviewRequired: false,
              reviewStatus: "none",
              createdAt: 100,
              completedAt: 200,
            },
          ];
        }
        return [];
      },
      getConversationMessages: (conversationId: string) => {
        assert.equal(conversationId, "conv-task-1");
        return [
          { conversationId, role: "user", content: "hello", createdAt: 1 },
          { conversationId, role: "assistant", content: longAssistantReply, createdAt: 2 },
        ];
      },
    } as any);

    assert.ok(context);
    assert.equal(context?.task.id, "task-1");
    assert.equal(context?.transcript.length, 10_000);
    assert.ok(context?.transcript.endsWith(longAssistantReply.slice(-9_987)));
    assert.ok(!context?.transcript.includes("User: hello"));
  });
});
