import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions, type ChatActions } from "../chat";
import { writeModelPreference } from "../../lib/preferencesStore";
import type { ProjectTab } from "../controllerTypes";

import { createSyncEventSequencer } from "./syncSequencer";
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

describe("sync event sequencer", () => {
  it("does not commit buffered live events when catch-up is aborted", () => {
    const writeCursor = vi.fn();
    const applied: number[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    sequencer.observe({ seq: 5 }, () => applied.push(5));
    sequencer.abortCatchUp();

    expect(applied).toEqual([]);
    expect(sequencer.getLastAppliedSeq()).toBe(0);
    expect(writeCursor).not.toHaveBeenCalled();

    sequencer.observe({ seq: 1 }, () => applied.push(1));

    expect(applied).toEqual([1]);
    expect(sequencer.getLastAppliedSeq()).toBe(1);
    expect(writeCursor).toHaveBeenLastCalledWith(1);
  });

  it("buffers unsequenced live events during catch-up and applies them after catch-up completes", () => {
    const writeCursor = vi.fn();
    const applied: string[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    // Live unsequenced event arrives while catch-up is in flight
    sequencer.observe({ type: "live" }, () => applied.push("unsequenced-live"));
    expect(applied).toEqual([]);

    // Sequenced catch-up item arrives
    sequencer.applyCatchUp({ seq: 1 }, () => applied.push("catch-up-1"));
    expect(applied).toEqual(["catch-up-1"]);

    // Catch-up completes
    sequencer.completeCatchUp();
    expect(applied).toEqual(["catch-up-1", "unsequenced-live"]);
  });

  it("drops buffered unsequenced events when catch-up is aborted", () => {
    const writeCursor = vi.fn();
    const applied: string[] = [];
    const sequencer = createSyncEventSequencer({ initialCursor: 0, writeCursor });

    sequencer.beginCatchUp();
    sequencer.observe({ type: "live" }, () => applied.push("unsequenced-live"));
    sequencer.abortCatchUp();

    expect(applied).toEqual([]);
  });
});

describe("webSocketActions model preference restore", () => {
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
