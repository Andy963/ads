import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import { createOutboxStore, OUTBOX_CHANNEL_NAME } from "../app/outbox";
import type { ProjectRuntime } from "../app/controller";

const mountHarness = (overrides: Partial<ProjectRuntime> = {}) => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = Object.assign(ctx.activeRuntime.value as ProjectRuntime, overrides);
  rt.projectSessionId = "session-1";
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  rt.ws = { sendPrompt: () => true } as never;
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
  return { chat, rt, handler };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Drives the real send path and returns the client id the runtime committed the
 * optimistic user bubble under.
 */
const sendPrompt = async (rt: ProjectRuntime, chat: ReturnType<typeof createChatActions>, text: string) => {
  chat.enqueuePrompt(text, [], rt);
  await settle();
  const bubble = rt.messages.value.find((message) => message.role === "user");
  expect(bubble).toBeDefined();
  return String(bubble?.id ?? "");
};

/** Simulates a sibling tab: the durable row exists here, the stream bubble does not. */
const dropUserBubbles = (rt: ProjectRuntime): void => {
  rt.messages.value = rt.messages.value.filter((message) => message.role !== "user");
};

const ackFrame = (clientMessageId: string, queueStatus = "queued") => ({
  type: "ack",
  client_message_id: clientMessageId,
  queue_status: queueStatus,
});

const queueEntry = (clientMessageId: string, status: string) => ({
  clientMessageId,
  status,
  position: 0,
  attempts: 1,
  createdAt: 1000,
  updatedAt: 1000,
  lastError: status === "failed" ? "Prompt execution failed." : "",
  laneGeneration: 1,
});

const cardsFor = (rt: ProjectRuntime, clientMessageId: string) =>
  rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === clientMessageId);

describe("issue-402 sent prompt renders once, not as a bubble plus a queue card", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("does not append a card on ack when the bubble already renders the prompt", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "hello from this tab");

    // The send path drops the optimistic card once the socket accepts it, so the
    // stream bubble is the only surviving rendering at ack time.
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(rt.messages.value.filter((message) => message.id === clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("still appends exactly one card on ack when the stream holds no matching bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "queued behind a busy lane");
    dropUserBubbles(rt);

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)[0]?.serverQueueTracked).toBe(true);
  });

  it("does not append a card on prompt_queue when the bubble already renders the prompt", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "hello again");

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "running") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("still appends exactly one card on prompt_queue when the stream holds no matching bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "sent from another tab");
    dropUserBubbles(rt);

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "queued") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });

  it("keeps the retry card for a failed prompt that already has a bubble", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "this one fails");

    // De-duplication must not swallow the failure card: it is the only surface
    // carrying the retry action.
    handler(ackFrame(clientMessageId, "failed") as never);
    await settle();

    const failed = cardsFor(rt, clientMessageId);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.deliveryStatus).toBe("failed");

    handler({ type: "prompt_queue", entry: queueEntry(clientMessageId, "failed") } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
    expect(cardsFor(rt, clientMessageId)[0]?.deliveryStatus).toBe("failed");
  });

  it("keeps the card for a replayed prompt that already has a bubble", async () => {
    const { rt, handler } = mountHarness();
    const clientMessageId = "cmid-replayed";
    // A reload replays the prompt with replay_incomplete. The bubble reappears,
    // but the card must survive until the backend confirms the replay landed.
    rt.messages.value = [...rt.messages.value, {
      id: clientMessageId,
      role: "user",
      kind: "text",
      content: "resumed after reload",
      ts: 1000,
    }];
    const outbox = createOutboxStore({ channelName: OUTBOX_CHANNEL_NAME });
    outbox.write("ads.outbox.session-1.main", {
      pending: null,
      sent: [{
        clientMessageId,
        text: "resumed after reload",
        createdAt: 1000,
        replayIncomplete: true,
        sentAwaitingAck: true,
      }],
      queued: [],
      dismissed: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    handler(ackFrame(clientMessageId) as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });

  it("reconstructs cards for a sibling tab's prompt on reconnect snapshot", async () => {
    const { rt, handler } = mountHarness();
    dropUserBubbles(rt);

    handler({ type: "prompt_queue_snapshot", entries: [queueEntry("cmid-sibling", "queued")] } as never);
    await settle();

    expect(cardsFor(rt, "cmid-sibling")).toHaveLength(1);
  });

  it("removes the card on the user frame once the turn is committed", async () => {
    const { rt, handler } = mountHarness();
    dropUserBubbles(rt);

    handler({ type: "prompt_queue", entry: queueEntry("cmid-cleanup", "running") } as never);
    await settle();
    expect(cardsFor(rt, "cmid-cleanup")).toHaveLength(1);

    handler({ type: "user", clientMessageId: "cmid-cleanup", text: "committed", kind: "text" } as never);
    await settle();

    expect(cardsFor(rt, "cmid-cleanup")).toHaveLength(0);
    expect(rt.messages.value.filter((message) => message.id === "cmid-cleanup")).toHaveLength(1);
  });
});
