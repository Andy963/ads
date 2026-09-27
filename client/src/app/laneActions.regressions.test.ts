import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readModelIdPreference, readReasoningEffortPreference } from "../lib/preferencesStore";

import { createAppContext, type AppContext } from "./controller";
import { createChatActions } from "./chat";
import { createLaneActions } from "./laneActions";

function createHarness(projectSessionId = "default") {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const actions = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
    connectWs: vi.fn(async () => {}),
    connectAcopilotWs: vi.fn(async () => {}),
  });
  const runtime = ctx.activeAcopilotRuntime.value;
  runtime.projectSessionId = projectSessionId;
  runtime.chatSessionId = "advisor";
  return { actions, chat, runtime };
}

describe("laneActions regressions", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  describe("lane model overrides", () => {
    function setupModelOverride() {
      const { actions, runtime } = createHarness("default");
      runtime.activeAgentId.value = "codex";
      runtime.modelReasoningEffort.value = "high";
      const send = vi.fn(() => true);
      runtime.ws = { send };
      return { actions, runtime, send };
    }

    it("sends the selected advisor model to the active WebSocket immediately", () => {
      const { actions, runtime, send } = setupModelOverride();

      actions.setAcopilotModelId("gpt-4o");

      expect(send).toHaveBeenCalledWith(
        "model_override",
        { model: "gpt-4o", model_reasoning_effort: "high" },
        { clientMessageId: expect.any(String) },
      );
      expect(runtime.modelId.value).toBe("gpt-4o");
      expect(readModelIdPreference("default", "advisor", "codex")).toBe("gpt-4o");
    });

    it("sends the current model with a changed reasoning effort", () => {
      const { actions, runtime, send } = setupModelOverride();
      runtime.modelId.value = "gpt-4o";

      actions.setAcopilotModelReasoningEffort("low");

      expect(send).toHaveBeenCalledWith(
        "model_override",
        { model: "gpt-4o", model_reasoning_effort: "low" },
        { clientMessageId: expect.any(String) },
      );
      expect(readReasoningEffortPreference("default", "advisor", "codex")).toBe("low");
    });
  });

  describe("Acopilot queue dismissal", () => {
    const OUTBOX_KEY = "ads.outbox.session-1.advisor";

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

      const first = createHarness("session-1");
      first.chat.restorePendingPrompt(first.runtime);
      const promptId = first.runtime.queuedPrompts.value[0]?.id;
      expect(promptId).toBeTruthy();

      first.actions.removeAcopilotQueuedPrompt(String(promptId));

      expect(first.runtime.queuedPrompts.value).toEqual([]);
      expect(first.runtime.dismissedPromptIds).toEqual(new Set(["cmid-acopilot-restored"]));
      const stored = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "{}") as { pending?: unknown; dismissed?: string[] };
      expect(stored.pending).toBeNull();
      expect(stored.dismissed).toEqual(["cmid-acopilot-restored"]);

      const second = createHarness("session-1");
      second.chat.restorePendingPrompt(second.runtime);

      expect(second.runtime.queuedPrompts.value).toEqual([]);
    });
  });
});
