import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions, type ChatActions } from "../chat";
import { writeModelPreference } from "../../lib/preferencesStore";
import type { ProjectTab } from "../controllerTypes";

import { createWebSocketActions } from "./webSocketActions";

vi.mock("../../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: unknown) => void;
    onError?: () => void;
    onMessage?: (msg: unknown) => void;

    constructor(_options: unknown) {}

    send = vi.fn(() => true);
    sendPrompt = vi.fn(() => true);
    interrupt = vi.fn(() => true);
    switchChatSession = vi.fn(() => true);
    clearHistory = vi.fn();
    connect = vi.fn();
    close = vi.fn();
  }

  return { AdsWebSocket };
});

const DEFAULT_PROJECT: ProjectTab = {
  id: "default",
  name: "default",
  path: "",
  sessionId: "default",
  chatSessionId: "main",
  initialized: true,
  createdAt: 1,
  updatedAt: 1,
};

function setup() {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const actions = createWebSocketActions({ ...ctx, ...chat } as AppContext & ChatActions, {
    updateProject: vi.fn(),
    persistProjects: vi.fn(),
  });
  ctx.loggedIn.value = true;
  ctx.projects.value = [{ ...DEFAULT_PROJECT }];
  return { ctx, actions };
}

describe("webSocketActions model preference restore", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("restores the agent-scoped advisor model and reasoning effort on reconnect", async () => {
    const { ctx, actions } = setup();
    writeModelPreference("default", "advisor", "codex", { modelId: "gpt-4o", effort: "low" });

    // Simulate the runtime state carried over from a previous connection: the
    // agent is already known, and the selector currently shows a stale value.
    const rt = ctx.getAcopilotRuntime("default");
    rt.activeAgentId.value = "codex";
    rt.modelId.value = "gemini-3.8-flash-high";
    rt.modelReasoningEffort.value = "high";

    await actions.connectAcopilotWs("default");

    expect(rt.modelId.value).toBe("gpt-4o");
    expect(rt.modelReasoningEffort.value).toBe("low");
  });

  it("restores the agent-scoped worker model and reasoning effort on reconnect", async () => {
    const { ctx, actions } = setup();
    writeModelPreference("default", "main", "claude", { modelId: "claude-opus-5", effort: "max" });

    const rt = ctx.getRuntime("default");
    rt.activeAgentId.value = "claude";
    rt.modelId.value = "auto";
    rt.modelReasoningEffort.value = "high";

    await actions.connectWs("default");

    expect(rt.modelId.value).toBe("claude-opus-5");
    expect(rt.modelReasoningEffort.value).toBe("max");
  });

  it("does not restore a preference stored under a different agent", async () => {
    const { ctx, actions } = setup();
    writeModelPreference("default", "advisor", "codex", { modelId: "gpt-4o" });

    const rt = ctx.getAcopilotRuntime("default");
    rt.activeAgentId.value = "claude";
    rt.modelId.value = "server-default";

    await actions.connectAcopilotWs("default");

    expect(rt.modelId.value).toBe("server-default");
  });
});
