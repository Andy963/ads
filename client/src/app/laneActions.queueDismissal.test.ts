import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext, type AppContext, type ProjectRuntime, type QueuedPrompt } from "./controller";
import { createChatActions } from "./chat";
import { createLaneActions } from "./laneActions";

const OUTBOX_KEY = "ads.outbox.session-1.advisor";

const createHarness = () => {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const actions = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
    connectWs: async () => {},
    connectAcopilotWs: async () => {},
  });
  const runtime = ctx.activeAcopilotRuntime.value as ProjectRuntime;
  runtime.projectSessionId = "session-1";
  runtime.chatSessionId = "advisor";
  return { actions, chat, runtime };
};

const restoredCard = (): QueuedPrompt => ({
  id: "q-acopilot-restored",
  clientMessageId: "cmid-acopilot-restored",
  text: "resume the interrupted Advisor turn",
  images: [],
  createdAt: 1000,
  restoredFromStorage: true,
  replayIncomplete: true,
  deliveryStatus: "offline",
});

describe("Acopilot queue dismissal", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("persists removal of a restored card across a reconnect", () => {
    const first = createHarness();
    first.runtime.queuedPrompts.value = [restoredCard()];

    first.actions.removeAcopilotQueuedPrompt("q-acopilot-restored");

    expect(first.runtime.queuedPrompts.value).toEqual([]);
    expect(first.runtime.dismissedPromptIds).toEqual(new Set(["cmid-acopilot-restored"]));
    const stored = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "{}") as { dismissed?: string[] };
    expect(stored.dismissed).toEqual(["cmid-acopilot-restored"]);

    const second = createHarness();
    second.chat.restorePendingPrompt(second.runtime);

    expect(second.runtime.queuedPrompts.value).toEqual([]);
  });
});
