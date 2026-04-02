import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentsPayload,
  buildWelcomePayload,
  buildWsBootstrapState,
} from "../../server/web/server/ws/bootstrapState.js";

describe("web/ws/bootstrapState", () => {
  it("builds bootstrap state from effective session state and merged agent readiness", () => {
    const sessionManager = {
      getSavedThreadId: () => "thread-saved",
      getContextRestoreMode: () => "thread_resumed",
      getEffectiveState: () => ({
        model: "gpt-4o",
        modelReasoningEffort: "high",
        activeAgentId: "codex",
      }),
    };
    const orchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "thread-live",
      listAgents: () => [
        { metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } },
        { metadata: { id: "claude", name: "Claude" }, status: { ready: true, streaming: true } },
      ],
    };
    const agentAvailability = {
      mergeStatus: (agentId: string, status: { ready: boolean; streaming: boolean }) =>
        agentId === "claude" ? { ...status, ready: false, error: "offline" } : status,
    };

    const state = buildWsBootstrapState({
      sessionManager: sessionManager as any,
      orchestrator: orchestrator as any,
      userId: 7,
      agentAvailability: agentAvailability as any,
    });

    assert.deepEqual(state, {
      threadId: "thread-live",
      contextMode: "thread_resumed",
      effectiveState: {
        model: "gpt-4o",
        modelReasoningEffort: "high",
        activeAgentId: "codex",
      },
      agents: [
        { id: "codex", name: "Codex", ready: true, error: undefined },
        { id: "claude", name: "Claude", ready: false, error: "offline" },
      ],
    });
  });

  it("builds welcome and agents payloads from bootstrap state", () => {
    const state = {
      threadId: "thread-live",
      contextMode: "history_injection",
      effectiveState: {
        model: "gpt-4.1",
        modelReasoningEffort: "medium",
        activeAgentId: "claude",
      },
      agents: [{ id: "claude", name: "Claude", ready: true }],
    } as const;

    assert.deepEqual(
      buildWelcomePayload({
        sessionId: "session-1",
        chatSessionId: "main",
        workspace: { path: "/tmp/project" },
        inFlight: true,
        state,
      }),
      {
        type: "welcome",
        message: "ADS WebSocket bridge ready.",
        workspace: { path: "/tmp/project" },
        sessionId: "session-1",
        chatSessionId: "main",
        inFlight: true,
        threadId: "thread-live",
        effectiveModel: "gpt-4.1",
        effectiveModelReasoningEffort: "medium",
        activeAgentId: "claude",
        contextMode: "history_injection",
      },
    );

    assert.deepEqual(buildAgentsPayload({ activeAgentId: "claude", state }), {
      type: "agents",
      activeAgentId: "claude",
      agents: [{ id: "claude", name: "Claude", ready: true }],
      threadId: "thread-live",
    });
  });

  it("only falls back to saved thread ids for resumed sessions", () => {
    const makeState = (contextMode: "fresh" | "history_injection" | "thread_resumed") =>
      buildWsBootstrapState({
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => contextMode,
          getEffectiveState: () => ({
            model: "gpt-4o",
            modelReasoningEffort: "high",
            activeAgentId: "codex",
          }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: {
          mergeStatus: (_agentId: string, status: { ready: boolean; streaming: boolean }) => status,
        } as any,
      });

    assert.equal(makeState("fresh").threadId, null);
    assert.equal(makeState("history_injection").threadId, null);
    assert.equal(makeState("thread_resumed").threadId, "thread-saved");
  });

  it("can suppress saved thread fallback when reviewer continuity is not safely bound", () => {
    const state = buildWsBootstrapState({
      sessionManager: {
        getSavedThreadId: () => "thread-saved",
        getContextRestoreMode: () => "thread_resumed",
        getEffectiveState: () => ({
          model: "gpt-4o",
          modelReasoningEffort: "high",
          activeAgentId: "codex",
        }),
      } as any,
      orchestrator: {
        getActiveAgentId: () => "codex",
        getThreadId: () => null,
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
      } as any,
      userId: 7,
      agentAvailability: { mergeStatus: (_agentId: string, status: { ready: boolean; streaming: boolean }) => status } as any,
      allowSavedThreadFallback: false,
    });

    assert.equal(state.threadId, null);
    assert.equal(state.contextMode, "thread_resumed");
  });
});
