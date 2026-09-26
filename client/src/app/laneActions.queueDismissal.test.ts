import { beforeEach, describe, expect, it } from "vitest";

import { createAppContext, type AppContext, type ProjectRuntime } from "./controller";
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

describe("Acopilot queue dismissal", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("persists removal of a restored card across a reconnect", () => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({
      pending: {
        clientMessageId: "cmid-acopilot-restored",
        text: "resume the interrupted Advisor turn",
        createdAt: 1000,
      },
      sent: [],
      queued: [],
      dismissed: [],
    }));

    const first = createHarness();
    first.chat.restorePendingPrompt(first.runtime);
    const promptId = first.runtime.queuedPrompts.value[0]?.id;
    expect(promptId).toBeTruthy();

    first.actions.removeAcopilotQueuedPrompt(String(promptId));

    expect(first.runtime.queuedPrompts.value).toEqual([]);
    expect(first.runtime.dismissedPromptIds).toEqual(new Set(["cmid-acopilot-restored"]));
    const stored = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "{}") as { pending?: unknown; dismissed?: string[] };
    expect(stored.pending).toBeNull();
    expect(stored.dismissed).toEqual(["cmid-acopilot-restored"]);

    const second = createHarness();
    second.chat.restorePendingPrompt(second.runtime);

    expect(second.runtime.queuedPrompts.value).toEqual([]);
  });
});
