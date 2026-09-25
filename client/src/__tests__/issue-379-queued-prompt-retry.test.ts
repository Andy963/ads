import { describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import type { ProjectRuntime, QueuedPrompt } from "../app/controller";

type SentFrame = { payload: Record<string, unknown>; clientMessageId: string };

const mountChatHarness = () => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = ctx.activeRuntime.value as ProjectRuntime;
  const sentFrames: SentFrame[] = [];
  rt.projectSessionId = "session-1";
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  rt.ws = {
    sendPrompt: (payload: unknown, clientMessageId?: string) => {
      sentFrames.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        clientMessageId: String(clientMessageId ?? ""),
      });
      return true;
    },
  };
  return { chat, rt, sentFrames };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const failedPrompt = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-failed",
  clientMessageId: "cmid-original",
  text: "resume the interrupted turn",
  images: [],
  createdAt: 1000,
  agentId: "claude",
  model: "auto",
  deliveryStatus: "failed",
  serverQueueTracked: true,
  queueError: "Prompt execution was interrupted before completion.",
  ...overrides,
});

describe("issue-379 failed queued prompt recovery", () => {
  it("replays a failed prompt under its original client id with incomplete-turn recovery", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [failedPrompt()];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // The server keys the durable row by client id, so an explicit retry has to
    // reuse it: that is what requeues the row instead of inserting a duplicate.
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.clientMessageId).toBe("cmid-original");
    expect(sentFrames[0]?.payload).toMatchObject({
      text: "resume the interrupted turn",
      agentId: "claude",
      replay_incomplete: true,
    });
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBe("cmid-original");
  });

  it("ignores retry for entries that are not in a failed state", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [failedPrompt({ id: "q-live", clientMessageId: "cmid-live", deliveryStatus: "queued" })];

    chat.retryQueuedPrompt("q-live", rt);
    chat.retryQueuedPrompt("missing-id", rt);
    await settle();

    expect(sentFrames).toHaveLength(0);
    expect(rt.queuedPrompts.value).toHaveLength(1);
  });

  it("keeps a retried prompt queued behind server-tracked work and clears the failure", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [
      failedPrompt({ id: "q-other", clientMessageId: "cmid-other", deliveryStatus: "queued", queueError: undefined }),
      failedPrompt(),
    ];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // A server-tracked entry is not resent by the client, so the retried prompt
    // becomes the sendable one but must not be dropped or reordered silently.
    expect(sentFrames.map((frame) => frame.clientMessageId)).toEqual(["cmid-original"]);
    expect(rt.queuedPrompts.value.map((entry) => entry.id)).toEqual(["q-other"]);
  });
});
