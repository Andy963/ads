import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions } from "../chat";
import {
  readModelIdPreference,
  readReasoningEffortPreference,
  writeModelPreference,
} from "../../lib/preferencesStore";
import type { ProjectRuntime } from "../controllerTypes";

import { createWsMessageHandler } from "./wsMessage";

const SERVER_DEFAULT_MODEL = "gemini-3.8-flash-high";

function setup(): { rt: ProjectRuntime; handler: (msg: unknown) => void } {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = ctx.getAcopilotRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = "advisor";
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId: ctx.randomId,
    updateProject: vi.fn(),
    applyResumeHistory: chat.applyResumeHistory,
    cancelPendingResume: chat.cancelPendingResume,
    clearPendingPrompt: chat.clearPendingPrompt,
    clearStepLive: chat.clearStepLive,
    commandKeyForWsEvent: chat.commandKeyForWsEvent,
    finalizeAssistant: chat.finalizeAssistant,
    finalizeCommandBlock: chat.finalizeCommandBlock,
    flushQueuedPrompts: chat.flushQueuedPrompts,
    ingestCommand: chat.ingestCommand,
    ingestCommandActivity: chat.ingestCommandActivity,
    ingestExploredActivity: chat.ingestExploredActivity,
    pushMessageBeforeLive: chat.pushMessageBeforeLive,
    threadReset: chat.threadReset,
    upsertExecuteBlock: chat.upsertExecuteBlock,
    upsertLiveActivity: chat.upsertLiveActivity,
    upsertStreamingDelta: chat.upsertStreamingDelta,
    replaceStreamingText: chat.replaceStreamingText,
  });
  return { rt, handler };
}

function welcomeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "welcome",
    chatSessionId: "advisor",
    threadId: null,
    contextMode: "fresh",
    inFlight: false,
    activeAgentId: "codex",
    effectiveModel: SERVER_DEFAULT_MODEL,
    effectiveModelReasoningEffort: "high",
    ...overrides,
  };
}

function resultFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    ok: true,
    output: "done",
    activeAgentId: "codex",
    effectiveModel: SERVER_DEFAULT_MODEL,
    effectiveModelReasoningEffort: "high",
    ...overrides,
  };
}

describe("wsMessage applyEffectiveState model preference guard", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("welcome does not overwrite a stored lane+agent selection or persist the server default", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "gpt-4o";
    rt.modelReasoningEffort.value = "low";
    writeModelPreference("default", "advisor", "codex", { modelId: "gpt-4o", effort: "low" });

    handler(welcomeFrame());

    expect(rt.modelId.value).toBe("gpt-4o");
    expect(rt.modelReasoningEffort.value).toBe("low");
    expect(readModelIdPreference("default", "advisor", "codex")).toBe("gpt-4o");
    expect(readReasoningEffortPreference("default", "advisor", "codex")).toBe("low");
  });

  it("welcome applies and persists the server default when no preference is stored", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "auto";

    handler(welcomeFrame({ effectiveModelReasoningEffort: "medium" }));

    expect(rt.modelId.value).toBe(SERVER_DEFAULT_MODEL);
    expect(rt.modelReasoningEffort.value).toBe("medium");
    expect(readModelIdPreference("default", "advisor", "codex")).toBe(SERVER_DEFAULT_MODEL);
    expect(readReasoningEffortPreference("default", "advisor", "codex")).toBe("medium");
  });

  it("handles a model override result without terminating the active chat turn", () => {
    const { rt, handler } = setup();
    rt.busy.value = true;
    rt.turnInFlight = true;

    handler({
      type: "result",
      ok: true,
      kind: "model_override",
      output: "Model switched to gpt-4o (low)",
      model: "gpt-4o",
      model_reasoning_effort: "low",
    });

    expect(rt.modelId.value).toBe("gpt-4o");
    expect(rt.modelReasoningEffort.value).toBe("low");
    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.laneStatus.value).toEqual({ kind: "info", message: "Model switched to: gpt-4o (low)" });
  });

  it("surfaces a model override failure without changing the selected model", () => {
    const { rt, handler } = setup();
    rt.modelId.value = "gpt-4.1";

    handler({
      type: "result",
      ok: false,
      kind: "model_override",
      output: "Unknown or disabled model: missing-model",
    });

    expect(rt.modelId.value).toBe("gpt-4.1");
    expect(rt.laneStatus.value).toEqual({
      kind: "error",
      message: "Unknown or disabled model: missing-model",
    });
  });

  it("welcome scopes the stored preference lookup to the payload's active agent", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    writeModelPreference("default", "advisor", "claude", { modelId: "claude-opus-5" });

    handler(welcomeFrame({ activeAgentId: "claude" }));

    expect(rt.activeAgentId.value).toBe("claude");
    expect(rt.modelId.value).toBe("claude-opus-5");
  });

  it("welcome applies the server default when only another agent has a stored preference", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "auto";
    writeModelPreference("default", "advisor", "claude", { modelId: "claude-opus-5" });

    handler(welcomeFrame());

    expect(rt.modelId.value).toBe(SERVER_DEFAULT_MODEL);
    expect(readModelIdPreference("default", "advisor", "claude")).toBe("claude-opus-5");
  });

  it("result does not overwrite a stored lane+agent selection or persist the server default", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "gpt-4o";
    rt.modelReasoningEffort.value = "low";
    writeModelPreference("default", "advisor", "codex", { modelId: "gpt-4o", effort: "low" });

    handler(resultFrame());

    expect(rt.modelId.value).toBe("gpt-4o");
    expect(rt.modelReasoningEffort.value).toBe("low");
    expect(readModelIdPreference("default", "advisor", "codex")).toBe("gpt-4o");
    expect(readReasoningEffortPreference("default", "advisor", "codex")).toBe("low");
  });

  it("result applies and persists the server default when no preference is stored", () => {
    const { rt, handler } = setup();
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "auto";

    handler(resultFrame());

    expect(rt.modelId.value).toBe(SERVER_DEFAULT_MODEL);
    expect(readModelIdPreference("default", "advisor", "codex")).toBe(SERVER_DEFAULT_MODEL);
  });
});
