import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import type { ProjectRuntime, QueuedPrompt } from "../app/controller";

type SentFrame = { payload: Record<string, unknown>; clientMessageId: string };

const mountChatHarness = (overrides: Partial<ProjectRuntime> = {}) => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = Object.assign(ctx.activeRuntime.value as ProjectRuntime, overrides);
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
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: () => true } as never,
    randomId: (prefix: string) => `${prefix}-1`,
    maxTurnCommands: 5,
    updateProject: () => undefined,
    ...chat,
  } as never);
  return { chat, rt, sentFrames, handler };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const failedServerCard = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-failed",
  clientMessageId: "cmid-original",
  text: "resume the interrupted turn",
  images: [],
  createdAt: 1000,
  agentId: "claude",
  model: "auto",
  deliveryStatus: "failed",
  serverQueueTracked: true,
  queueLaneGeneration: 1,
  queueError: "Prompt execution was interrupted before completion.",
  ...overrides,
});

describe("issue-379 failed queued prompt recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("replays a failed prompt under its original client id with incomplete-turn recovery", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [failedServerCard()];

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

  it("re-keys a retry whose durable row belongs to an older lane generation", async () => {
    const { chat, rt, sentFrames } = mountChatHarness({ laneGeneration: 2 });
    rt.queuedPrompts.value = [failedServerCard({ queueLaneGeneration: 1 })];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    // The client id is bound to the generation it was written under, so replaying
    // it into a reset lane would be rejected as a different prompt scope. Work
    // stranded by a reset has to be resubmitted under a fresh id instead.
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.clientMessageId).not.toBe("cmid-original");
    expect(String(sentFrames[0]?.clientMessageId ?? "")).not.toBe("");
    expect(sentFrames[0]?.payload).toMatchObject({ replay_incomplete: true });
  });

  it("keeps a retried prompt queued behind server-tracked work", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [
      failedServerCard({ id: "q-other", clientMessageId: "cmid-other", deliveryStatus: "queued", queueError: undefined }),
      failedServerCard(),
    ];

    chat.retryQueuedPrompt("q-failed", rt);
    await settle();

    expect(sentFrames.map((frame) => frame.clientMessageId)).toEqual(["cmid-original"]);
    expect(rt.queuedPrompts.value.map((entry) => entry.id)).toEqual(["q-other"]);
  });

  it("ignores retry for entries that are not in a failed state", async () => {
    const { chat, rt, sentFrames } = mountChatHarness();
    rt.queuedPrompts.value = [failedServerCard({ id: "q-live", deliveryStatus: "queued" })];

    chat.retryQueuedPrompt("q-live", rt);
    chat.retryQueuedPrompt("missing-id", rt);
    await settle();

    expect(sentFrames).toHaveLength(0);
    expect(rt.queuedPrompts.value).toHaveLength(1);
  });

  it("keeps a removed server card removed across queue snapshots", async () => {
    const { chat, rt, handler } = mountChatHarness();
    const snapshot = {
      type: "prompt_queue_snapshot",
      entries: [{
        clientMessageId: "cmid-original",
        status: "failed",
        position: 0,
        attempts: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastError: "Prompt execution was interrupted before completion.",
        laneGeneration: 1,
      }],
    };

    handler(snapshot as never);
    await settle();
    expect(rt.queuedPrompts.value.map((entry) => entry.id)).toEqual(["server-cmid-original"]);

    chat.removeQueuedPrompt("server-cmid-original", rt);
    await settle();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(Array.from(rt.dismissedPromptIds ?? [])).toEqual(["cmid-original"]);

    // The durable row still exists server-side, so the snapshot would otherwise
    // resurrect the card the user just dismissed.
    handler(snapshot as never);
    await settle();
    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("keeps server-owned cards when a sibling tab broadcasts its outbox", async () => {
    const { chat: chatA, rt: rtA } = mountChatHarness();
    const { chat: chatB, rt: rtB } = mountChatHarness();

    // Both tabs share one outbox key, so both must bind before either writes.
    chatB.enqueuePrompt("from tab b", [], rtB);
    chatA.enqueuePrompt("from tab a", [], rtA);
    await settle();

    // Tab A also shows a card the server owns. The outbox deliberately omits
    // acknowledged server work, so it is absent from any broadcast snapshot.
    rtA.queuedPrompts.value = [
      ...rtA.queuedPrompts.value,
      failedServerCard({ id: "server-cmid-1", clientMessageId: "cmid-server", deliveryStatus: "queued" }),
    ];

    chatB.enqueuePrompt("second from tab b", [], rtB);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(rtA.queuedPrompts.value.map((entry) => entry.clientMessageId)).toContain("cmid-server");
  });

  it("restores dismissals written by a sibling tab", () => {
    const { rt: first } = mountChatHarness();
    const { chat, rt: second } = mountChatHarness();

    second.queuedPrompts.value = [failedServerCard()];
    chat.removeQueuedPrompt("q-failed", second);

    const stored = JSON.parse(localStorage.getItem("ads.outbox.session-1.main") ?? "{}") as { dismissed?: string[] };
    expect(stored.dismissed).toEqual(["cmid-original"]);

    first.queuedPrompts.value = [failedServerCard({ id: "server-cmid-original" })];
    chat.enqueuePrompt("unrelated", [], first);
    // The dismissal is restored when this tab binds its own outbox.
    expect(first.queuedPrompts.value.some((entry) => entry.clientMessageId === "cmid-original")).toBe(false);
  });
});
