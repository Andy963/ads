import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";
import type { ProjectRuntime, QueuedPrompt } from "../app/controller";

const OUTBOX_KEY = "ads.outbox.session-1.main";

const mountHarness = () => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as never);
  const rt = ctx.activeRuntime.value as ProjectRuntime;
  rt.projectSessionId = "session-1";
  rt.chatSessionId = "main";
  rt.connected.value = true;
  rt.inputLocked.value = false;
  rt.laneGeneration = 1;
  rt.ws = { sendPrompt: () => true, send: () => true, clearHistory: () => {} } as never;
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: () => true } as never,
    randomId: (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
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

const card = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: "q-1",
  clientMessageId: "cmid-gone",
  text: "restore the backend context thread",
  images: [],
  createdAt: 1000,
  agentId: "claude",
  model: "auto",
  deliveryStatus: "queued",
  serverQueueTracked: true,
  restoredFromStorage: true,
  queueLaneGeneration: 1,
  ...overrides,
});

const readOutbox = (): { queued: unknown[]; dismissed: string[] } => {
  const raw = localStorage.getItem(OUTBOX_KEY);
  if (!raw) return { queued: [], dismissed: [] };
  const parsed = JSON.parse(raw) as { queued?: unknown[]; dismissed?: string[] };
  return { queued: parsed.queued ?? [], dismissed: parsed.dismissed ?? [] };
};

describe("dismissed queue cards stay dismissed across a restart", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("honours a dismissal for an entry that is still listed in the outbox", () => {
    // Removing a card leaves it in the persisted outbox, so storage holds both
    // the stale entry and the dismissal. The dismissal has to win, otherwise the
    // next reconnect rebuilds a card the user explicitly deleted.
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({
      pending: null,
      sent: [],
      queued: [{ ...card(), deliveryStatus: "offline" }],
      dismissed: ["cmid-gone"],
    }));

    const { chat, rt } = mountHarness();
    chat.restorePendingPrompt(rt);

    expect(Array.from(rt.dismissedPromptIds ?? [])).toEqual(["cmid-gone"]);
    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("does not write a dismissed card back into the outbox", async () => {
    const { chat, rt } = mountHarness();
    rt.queuedPrompts.value = [card()];

    chat.removeQueuedPrompt("q-1", rt);
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    // Re-persisting it is what closed the loop: restore rebuilt the card, the
    // snapshot flipped it to `offline`, and the watcher stored it again.
    expect(readOutbox().queued).toEqual([]);
    expect(readOutbox().dismissed).toEqual(["cmid-gone"]);
  });

  it("does not resurrect a dismissed card when a later snapshot omits it", async () => {
    const { chat, rt, handler } = mountHarness();
    rt.queuedPrompts.value = [card()];
    chat.removeQueuedPrompt("q-1", rt);
    await settle();

    handler({ type: "prompt_queue_snapshot", entries: [] });
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
    expect(readOutbox().queued).toEqual([]);
  });

  it("drops an already-dismissed offline card during snapshot reconciliation", async () => {
    // The snapshot tail keeps `offline` cards unconditionally, so a dismissed
    // card that is already marked offline used to survive it. Removal has to be
    // authoritative at this layer too, or the card is persisted again.
    const { rt, handler } = mountHarness();
    rt.dismissedPromptIds = new Set(["cmid-gone"]);
    rt.queuedPrompts.value = [card({ deliveryStatus: "offline" })];

    handler({ type: "prompt_queue_snapshot", entries: [] });
    await settle();

    expect(rt.queuedPrompts.value).toEqual([]);
  });

  it("breaks the dismiss -> offline -> persist -> restore cycle end to end", async () => {
    // Session 1: the user deletes a card that the server still tracks.
    const first = mountHarness();
    first.rt.queuedPrompts.value = [card()];
    first.chat.removeQueuedPrompt("q-1", first.rt);
    await settle();
    expect(readOutbox().dismissed).toEqual(["cmid-gone"]);

    // Session 2: a restart, then the server re-advertises the durable row.
    const second = mountHarness();
    second.chat.restorePendingPrompt(second.rt);
    await settle();
    second.handler({
      type: "prompt_queue_snapshot",
      entries: [{
        clientMessageId: "cmid-gone",
        status: "failed",
        position: 0,
        attempts: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastError: "Prompt execution was interrupted before completion.",
        laneGeneration: 1,
      }],
    });
    await settle();

    expect(second.rt.queuedPrompts.value).toEqual([]);
    // And nothing was written back that a third session could pick up.
    expect(readOutbox().queued).toEqual([]);
  });
});
