import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
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

const sendPrompt = async (rt: ProjectRuntime, chat: ReturnType<typeof createChatActions>, text: string) => {
  chat.enqueuePrompt(text, [], rt);
  await settle();
  const bubble = rt.messages.value.find((message) => message.role === "user");
  expect(bubble).toBeDefined();
  return String(bubble?.id ?? "");
};

const queueEntry = (clientMessageId: string, status: string) => ({
  clientMessageId,
  status,
  position: 0,
  attempts: 1,
  createdAt: 1000,
  updatedAt: 1000,
  completedAt: status === "completed" ? 2000 : null,
  lastError: "",
  laneGeneration: 1,
});

const cardsFor = (rt: ProjectRuntime, clientMessageId: string) =>
  rt.queuedPrompts.value.filter((entry) => entry.clientMessageId === clientMessageId);

describe("a restored queue card does not survive the server reporting the prompt completed", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("drops the card and the durable outbox entry when the snapshot reports completed", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "sent before the deploy");

    // The acknowledgement never reached this tab, so the durable outbox still
    // holds the prompt and the next reconnect restores it as a card.
    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "completed")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
    expect(rt.consumedPromptIds?.has(clientMessageId)).toBe(true);
    expect(JSON.parse(localStorage.getItem("ads.outbox.session-1.main") ?? "{}").consumed).toEqual([clientMessageId]);
    // The consumed marker prevents a later reconnect from resurrecting it.
    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("marks a running prompt consumed before a stale queued snapshot can restore it", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "already picked up by the worker");

    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "running")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
    expect(rt.consumedPromptIds?.has(clientMessageId)).toBe(true);

    localStorage.setItem("ads.outbox.session-1.main", JSON.stringify({
      pending: null,
      sent: [],
      queued: [{ clientMessageId, text: "already picked up by the worker", createdAt: 1000 }],
      dismissed: [],
      consumed: [clientMessageId],
    }));
    chat.restorePendingPrompt(rt);

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("does not restore a queued entry already marked consumed", () => {
    const clientMessageId = "cmid-consumed-queued";
    localStorage.setItem("ads.outbox.session-1.main", JSON.stringify({
      pending: { clientMessageId, text: "already consumed", createdAt: 1000 },
      sent: [],
      queued: [{ clientMessageId, text: "already consumed", createdAt: 1000 }],
      dismissed: [],
      consumed: [clientMessageId],
    }));

    const { chat, rt } = mountHarness();
    chat.restorePendingPrompt(rt);

    expect(cardsFor(rt, clientMessageId)).toHaveLength(0);
  });

  it("keeps a card the snapshot still reports as live", async () => {
    const { chat, rt, handler } = mountHarness();
    const clientMessageId = await sendPrompt(rt, chat, "still waiting its turn");

    chat.restorePendingPrompt(rt);
    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);

    handler({
      type: "prompt_queue_snapshot",
      entries: [queueEntry(clientMessageId, "queued")],
    } as never);
    await settle();

    expect(cardsFor(rt, clientMessageId)).toHaveLength(1);
  });
});
