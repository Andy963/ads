import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { sendInitialBootstrapMessages } from "../../server/web/server/ws/bootstrapDelivery.js";

describe("web/ws/bootstrapDelivery", () => {
  it("does not replay stale history when the backend context is fresh", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[0] as { bootstrapHistory?: unknown }).bootstrapHistory, false);
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal(sent.length, 2);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("reports completed fresh-mode prompts without replaying stale history", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({
      namespace: "test-bootstrap-delivery-fresh-completed",
      maxEntriesPerSession: 20,
    });
    historyStore.add("history-1", {
      role: "user",
      text: "apply the change",
      ts: 1,
      kind: "client_message_id:prompt-1",
    });
    historyStore.add("history-1", { role: "ai", text: "Done.", ts: 2 });
    historyStore.add("history-1", { role: "status", text: "已恢复后端上下文线程。", ts: 3, kind: "status" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[0] as { bootstrapHistory?: unknown }).bootstrapHistory, false);
      assert.deepEqual((sent[0] as { completedClientMessageIds?: unknown }).completedClientMessageIds, ["prompt-1"]);
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal(sent.length, 2);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("replays fresh-mode terminal error history so reconnect explains failed turns", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-error", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });
    historyStore.add("history-1", { role: "status", text: "已中断，输出可能不完整", ts: 2, kind: "error" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[0] as { bootstrapHistory?: unknown }).bootstrapHistory, true);
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], {
        type: "history",
        items: [
          { role: "user", text: "hello", ts: 1, kind: undefined },
          { role: "status", text: "已中断，输出可能不完整", ts: 2, kind: "error" },
        ],
      });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("replays fresh-mode execute history so reconnect explains command results", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-execute", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "npm test", ts: 1 });
    historyStore.add("history-1", { role: "status", text: "$ npm test\nTests failed", ts: 2, kind: "execute" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[0] as { bootstrapHistory?: unknown }).bootstrapHistory, true);
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], {
        type: "history",
        items: [
          { role: "user", text: "npm test", ts: 1, kind: undefined },
          { role: "status", text: "$ npm test\nTests failed", ts: 2, kind: "execute" },
        ],
      });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("replays fresh-mode command history even when a generic status notice follows it", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-execute-after-status", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "npm test", ts: 1 });
    historyStore.add("history-1", { role: "status", text: "$ npm test\nTests failed", ts: 2, kind: "execute" });
    historyStore.add("history-1", { role: "status", text: "已恢复后端上下文线程。", ts: 3, kind: "status" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], {
        type: "history",
        items: [
          { role: "user", text: "npm test", ts: 1, kind: undefined },
          { role: "status", text: "$ npm test\nTests failed", ts: 2, kind: "execute" },
        ],
      });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("replays fresh-mode builtin command status so reconnect keeps visible command results", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-builtin-status", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "/pwd", ts: 1 });
    historyStore.add("history-1", { role: "status", text: "当前工作目录: /tmp/project", ts: 2, kind: "status" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], {
        type: "history",
        items: [
          { role: "user", text: "/pwd", ts: 1, kind: undefined },
          { role: "status", text: "当前工作目录: /tmp/project", ts: 2, kind: "status" },
        ],
      });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("does not replay fresh-mode generic status notices", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-generic-status", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "status", text: "已恢复后端上下文线程。", ts: 1, kind: "status" });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal(sent.length, 2);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("replays history when a fresh-mode runtime already has a live thread", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-fresh-live", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "thread-live",
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal((sent[2] as { type?: unknown }).type, "history");
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("sends an empty history marker when restored context has no replay entries", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-empty-restored", maxEntriesPerSession: 20 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "thread_resumed",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "thread-live",
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], { type: "history", items: [] });
      assert.deepEqual(sent[3], { type: "status", message: "已恢复后端上下文线程。", kind: "status" });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("announces in-flight backend work during reconnect bootstrap", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-in-flight", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "still running", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => undefined,
          getContextRestoreMode: () => "fresh",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: true,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.deepEqual(sent[2], {
        type: "history",
        items: [{ role: "user", text: "still running", ts: 1, kind: undefined }],
      });
      assert.deepEqual(sent[3], { type: "status", message: "上一轮仍在执行，正在等待后端结果。", kind: "status" });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("sends welcome, agents, and history in order for history injection continuity", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-history-injection", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "history_injection",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal((sent[2] as { type?: unknown }).type, "history");
      assert.deepEqual(sent[3], {
        type: "status",
        message: "后端线程未直接恢复；下一轮发送时会注入最近聊天历史来延续上下文。",
        kind: "status",
      });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("announces restored backend thread continuity after bootstrap history", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-thread-resumed", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "hello", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "thread_resumed",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "thread-live",
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "custom-worker",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
      });

      assert.equal((sent[0] as { type?: unknown }).type, "welcome");
      assert.equal((sent[1] as { type?: unknown }).type, "agents");
      assert.equal((sent[2] as { type?: unknown }).type, "history");
      assert.deepEqual(sent[3], { type: "status", message: "已恢复后端上下文线程。", kind: "status" });
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("merges shared worker history into the initial bootstrap snapshot", () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-bootstrap-delivery-shared", maxEntriesPerSession: 20 });
    historyStore.add("history-1", { role: "user", text: "queued task", ts: 1 });

    try {
      sendInitialBootstrapMessages({
        ws: {} as any,
        safeJsonSend: (_ws, payload) => sent.push(payload),
        sessionManager: {
          getSavedThreadId: () => "thread-saved",
          getContextRestoreMode: () => "thread_resumed",
          getEffectiveState: () => ({ model: "gpt-4o", modelReasoningEffort: "high", activeAgentId: "codex" }),
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "thread-live",
          listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        } as any,
        userId: 7,
        agentAvailability: { mergeStatus: (_agentId, status) => status } as any,
        sessionId: "session-1",
        chatSessionId: "main",
        workspace: { path: "/tmp/project" },
        inFlight: false,
        historyStore,
        historyKey: "history-1",
        additionalHistoryEntries: [{ role: "ai", text: "offline task result", ts: 2 }],
      });

      assert.deepEqual((sent[2] as { items?: unknown }).items, [
        { role: "user", text: "queued task", ts: 1, kind: undefined },
        { role: "ai", text: "offline task result", ts: 2, kind: undefined },
      ]);
    } finally {
      historyStore.clear("history-1");
    }
  });
});
