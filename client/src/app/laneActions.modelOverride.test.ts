import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readModelIdPreference, readReasoningEffortPreference } from "../lib/preferencesStore";

import { createAppContext, type AppContext } from "./controller";
import { createChatActions } from "./chat";
import { createLaneActions } from "./laneActions";

function setup() {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const actions = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
    connectWs: vi.fn(async () => {}),
    connectAdvisorWs: vi.fn(async () => {}),
  });
  const runtime = ctx.activeAdvisorRuntime.value;
  runtime.projectSessionId = "default";
  runtime.chatSessionId = "advisor";
  runtime.activeAgentId.value = "codex";
  runtime.modelReasoningEffort.value = "high";
  const send = vi.fn(() => true);
  runtime.ws = { send };
  return { actions, runtime, send };
}

describe("lane model overrides", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("sends the selected advisor model to the active WebSocket immediately", () => {
    const { actions, runtime, send } = setup();

    actions.setAdvisorModelId("gpt-4o");

    expect(send).toHaveBeenCalledWith(
      "model_override",
      { model: "gpt-4o", model_reasoning_effort: "high" },
      { clientMessageId: expect.any(String) },
    );
    expect(runtime.modelId.value).toBe("gpt-4o");
    expect(readModelIdPreference("default", "advisor", "codex")).toBe("gpt-4o");
  });

  it("sends the current model with a changed reasoning effort", () => {
    const { actions, runtime, send } = setup();
    runtime.modelId.value = "gpt-4o";

    actions.setAdvisorModelReasoningEffort("low");

    expect(send).toHaveBeenCalledWith(
      "model_override",
      { model: "gpt-4o", model_reasoning_effort: "low" },
      { clientMessageId: expect.any(String) },
    );
    expect(readReasoningEffortPreference("default", "advisor", "codex")).toBe("low");
  });
});
