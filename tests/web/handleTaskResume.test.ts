import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleTaskResumeMessage } from "../../server/web/server/ws/handleTaskResume.js";

describe("web/ws/handleTaskResume", () => {
  const originalCodexBin = process.env.ADS_CODEX_BIN;

  afterEach(() => {
    if (originalCodexBin === undefined) {
      delete process.env.ADS_CODEX_BIN;
      return;
    }
    process.env.ADS_CODEX_BIN = originalCodexBin;
  });

  it("prefers current lane history over older task transcripts when thread resume is unavailable", async () => {
    const sent: unknown[] = [];
    const historyEntries = [
      { role: "user", text: "current question", ts: 1 },
      { role: "ai", text: "current answer", ts: 2 },
      { role: "status", text: "ignored status", ts: 3 },
    ];
    const dropSessionCalls: Array<{ clearSavedThread?: boolean }> = [];
    const saveThreadCalls: Array<{ userId: number; threadId: string; agentId?: string }> = [];
    const getOrCreateCalls: Array<{ userId: number; cwd?: string; resumeThread?: boolean }> = [];
    let listTasksCalls = 0;
    let getConversationMessagesCalls = 0;

    const initialOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "claude-current-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "new-claude-session",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async (prompt: string, options: { streaming: boolean }) => {
        assert.match(prompt, /User: current question/);
        assert.match(prompt, /Assistant: current answer/);
        assert.doesNotMatch(prompt, /old task transcript/);
        assert.equal(options.streaming, false);
      },
    };

    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { mode: "auto" },
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
      },
      observability: {
        logger: {
          info: () => {},
          debug: () => {},
          warn: () => {},
        },
      },
      context: {
        userId: 9,
        historyKey: "history-3",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => "claude-saved-thread",
          getSavedResumeThreadId: () => "saved-resume-thread",
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {},
          dropSession: (_userId: number, options?: { clearSavedThread?: boolean }) => {
            dropSessionCalls.push(options ?? {});
          },
          getOrCreate: (userId: number, cwd?: string, resumeThread?: boolean) => {
            getOrCreateCalls.push({ userId, cwd, resumeThread });
            return fallbackOrchestrator as any;
          },
          saveThreadId: (userId: number, threadId: string, agentId?: string) => {
            saveThreadCalls.push({ userId, threadId, agentId });
          },
        } as any,
        orchestrator: initialOrchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          clear: () => {
            historyEntries.length = 0;
          },
          add: (_key: string, entry: { role: string; text: string; ts: number }) => {
            historyEntries.push(entry);
          },
          get: () => historyEntries,
        } as any,
      },
      tasks: {
        ensureTaskContext: () => ({
          queueRunning: false,
          taskStore: {
            getActiveTaskId: () => null,
            listTasks: () => {
              listTasksCalls += 1;
              return [{
                id: "task-old",
                title: "Older task",
                prompt: "prompt",
                model: "claude",
                status: "completed",
                priority: 0,
                queueOrder: 0,
                inheritContext: false,
                agentId: null,
                retryCount: 0,
                maxRetries: 0,
                reviewRequired: false,
                reviewStatus: "none",
                createdAt: 1,
                completedAt: 2,
              }];
            },
            getConversationMessages: () => {
              getConversationMessagesCalls += 1;
              return [
                { conversationId: "conv-task-old", role: "user", content: "old task transcript", createdAt: 1 },
                { conversationId: "conv-task-old", role: "assistant", content: "old task answer", createdAt: 2 },
              ];
            },
          },
        }) as any,
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.orchestrator, fallbackOrchestrator);
    assert.equal(listTasksCalls, 0);
    assert.equal(getConversationMessagesCalls, 0);
    assert.deepEqual(dropSessionCalls, [{}]);
    assert.deepEqual(getOrCreateCalls, [{ userId: 9, cwd: "/mnt/d/code/ADS/ads", resumeThread: false }]);
    assert.deepEqual(saveThreadCalls, [{ userId: 9, threadId: "new-claude-session", agentId: "claude" }]);
    assert.deepEqual(sent.at(-1), {
      type: "history",
      items: [
        {
          role: "user",
          text: "current question",
          ts: 1,
        },
        {
          role: "ai",
          text: "current answer",
          ts: 2,
        },
        {
          role: "status",
          text: "ignored status",
          ts: 3,
        },
        {
          role: "status",
          text: "已从当前对话恢复上下文",
          ts: historyEntries.at(-1)?.ts,
        },
      ],
    });
  });

  it("keeps prior lane history when transcript restore fails", async () => {
    const sent: unknown[] = [];
    const historyEntries = [
      { role: "user", text: "current question", ts: 1 },
      { role: "ai", text: "current answer", ts: 2 },
      { role: "status", text: "existing status", ts: 3 },
    ];
    const originalHistoryEntries = historyEntries.map((entry) => ({ ...entry }));
    const saveThreadCalls: Array<{ userId: number; threadId: string; agentId?: string }> = [];

    const initialOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "claude-current-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "new-claude-session",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async () => {
        throw new Error("restore exploded");
      },
    };

    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { mode: "auto" },
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
      },
      observability: {
        logger: {
          info: () => {},
          debug: () => {},
          warn: () => {},
        },
      },
      context: {
        userId: 10,
        historyKey: "history-failed-restore",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => "claude-saved-thread",
          getSavedResumeThreadId: () => "saved-resume-thread",
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {},
          dropSession: () => {},
          getOrCreate: () => fallbackOrchestrator as any,
          saveThreadId: (userId: number, threadId: string, agentId?: string) => {
            saveThreadCalls.push({ userId, threadId, agentId });
          },
        } as any,
        orchestrator: initialOrchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          clear: () => {
            historyEntries.length = 0;
          },
          add: (_key: string, entry: { role: string; text: string; ts: number }) => {
            historyEntries.push(entry);
          },
          get: () => historyEntries,
        } as any,
      },
      tasks: {
        ensureTaskContext: () => ({
          queueRunning: false,
          taskStore: {
            getActiveTaskId: () => null,
            listTasks: () => [],
            getConversationMessages: () => [],
          },
        }) as any,
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.orchestrator, fallbackOrchestrator);
    assert.deepEqual(saveThreadCalls, []);
    assert.deepEqual(historyEntries, originalHistoryEntries);
    assert.deepEqual(sent, [{ type: "error", message: "恢复失败: restore exploded" }]);
  });

  it("preserves saved resume continuity when probe fails and falls back to transcript restore", async () => {
    process.env.ADS_CODEX_BIN = process.execPath;

    const sent: unknown[] = [];
    const historyEntries: Array<{ role: string; text: string; ts: number }> = [];
    const dropSessionCalls: Array<{ clearSavedThread?: boolean }> = [];
    const saveThreadCalls: Array<{ userId: number; threadId: string; agentId?: string }> = [];
    const getOrCreateCalls: Array<{ userId: number; cwd?: string; resumeThread?: boolean }> = [];
    let clearSavedResumeCalls = 0;

    const initialOrchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => null,
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "new-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async (prompt: string, options: { streaming: boolean }) => {
        assert.match(prompt, /恢复对话上下文/);
        assert.equal(options.streaming, false);
      },
    };

    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { mode: "auto" },
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
      },
      observability: {
        logger: {
          info: () => {},
          debug: () => {},
          warn: () => {},
        },
      },
      context: {
        userId: 7,
        historyKey: "history-1",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => "saved-resume-thread",
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {
            clearSavedResumeCalls += 1;
          },
          dropSession: (_userId: number, options?: { clearSavedThread?: boolean }) => {
            dropSessionCalls.push(options ?? {});
          },
          getOrCreate: (userId: number, cwd?: string, resumeThread?: boolean) => {
            getOrCreateCalls.push({ userId, cwd, resumeThread });
            return fallbackOrchestrator as any;
          },
          saveThreadId: (userId: number, threadId: string, agentId?: string) => {
            saveThreadCalls.push({ userId, threadId, agentId });
          },
        } as any,
        orchestrator: initialOrchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          clear: () => {
            historyEntries.length = 0;
          },
          add: (_key: string, entry: { role: string; text: string; ts: number }) => {
            historyEntries.push(entry);
          },
          get: () => historyEntries,
        } as any,
      },
      tasks: {
        ensureTaskContext: () => ({
          queueRunning: false,
          taskStore: {
            getActiveTaskId: () => null,
            listTasks: ({ status }: { status?: string }) =>
              status === "completed"
                ? [{
                    id: "task-1",
                    title: "Recent task",
                    prompt: "prompt",
                    model: "gpt",
                    status: "completed",
                    priority: 0,
                    queueOrder: 0,
                    inheritContext: false,
                    agentId: null,
                    retryCount: 0,
                    maxRetries: 0,
                    reviewRequired: false,
                    reviewStatus: "none",
                    createdAt: 1,
                    completedAt: 2,
                  }]
                : [],
            getConversationMessages: () => [
              { conversationId: "conv-task-1", role: "user", content: "hello", createdAt: 1 },
              { conversationId: "conv-task-1", role: "assistant", content: "hi", createdAt: 2 },
            ],
          },
        }) as any,
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.orchestrator, fallbackOrchestrator);
    assert.equal(clearSavedResumeCalls, 0);
    assert.deepEqual(dropSessionCalls, [{}]);
    assert.deepEqual(getOrCreateCalls, [{ userId: 7, cwd: "/mnt/d/code/ADS/ads", resumeThread: false }]);
    assert.deepEqual(saveThreadCalls, [{ userId: 7, threadId: "new-thread", agentId: "codex" }]);
    assert.deepEqual(sent.at(-1), {
      type: "history",
      items: [
        {
          role: "status",
          text: "已从最近任务恢复上下文：Recent task",
          ts: historyEntries[0]?.ts,
        },
      ],
    });
  });

  it("skips thread resume selection for non-codex agents and restores transcript directly", async () => {
    const sent: unknown[] = [];
    const historyEntries: Array<{ role: string; text: string; ts: number }> = [];
    const dropSessionCalls: Array<{ clearSavedThread?: boolean }> = [];
    const saveThreadCalls: Array<{ userId: number; threadId: string; agentId?: string }> = [];
    const getOrCreateCalls: Array<{ userId: number; cwd?: string; resumeThread?: boolean }> = [];
    const warnings: string[] = [];
    let clearSavedResumeCalls = 0;

    const initialOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "claude-current-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "new-claude-session",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async (prompt: string, options: { streaming: boolean }) => {
        assert.match(prompt, /恢复对话上下文/);
        assert.equal(options.streaming, false);
      },
    };

    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { mode: "auto" },
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
      },
      observability: {
        logger: {
          info: () => {},
          debug: () => {},
          warn: (message: string) => {
            warnings.push(message);
          },
        },
      },
      context: {
        userId: 8,
        historyKey: "history-2",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => "claude-saved-thread",
          getSavedResumeThreadId: () => "saved-resume-thread",
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {
            clearSavedResumeCalls += 1;
          },
          dropSession: (_userId: number, options?: { clearSavedThread?: boolean }) => {
            dropSessionCalls.push(options ?? {});
          },
          getOrCreate: (userId: number, cwd?: string, resumeThread?: boolean) => {
            getOrCreateCalls.push({ userId, cwd, resumeThread });
            return fallbackOrchestrator as any;
          },
          saveThreadId: (userId: number, threadId: string, agentId?: string) => {
            saveThreadCalls.push({ userId, threadId, agentId });
          },
        } as any,
        orchestrator: initialOrchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          clear: () => {
            historyEntries.length = 0;
          },
          add: (_key: string, entry: { role: string; text: string; ts: number }) => {
            historyEntries.push(entry);
          },
          get: () => historyEntries,
        } as any,
      },
      tasks: {
        ensureTaskContext: () => ({
          queueRunning: false,
          taskStore: {
            getActiveTaskId: () => null,
            listTasks: ({ status }: { status?: string }) =>
              status === "completed"
                ? [{
                    id: "task-2",
                    title: "Recent Claude task",
                    prompt: "prompt",
                    model: "claude",
                    status: "completed",
                    priority: 0,
                    queueOrder: 0,
                    inheritContext: false,
                    agentId: null,
                    retryCount: 0,
                    maxRetries: 0,
                    reviewRequired: false,
                    reviewStatus: "none",
                    createdAt: 1,
                    completedAt: 2,
                  }]
                : [],
            getConversationMessages: () => [
              { conversationId: "conv-task-2", role: "user", content: "hello", createdAt: 1 },
              { conversationId: "conv-task-2", role: "assistant", content: "hi", createdAt: 2 },
            ],
          },
        }) as any,
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.orchestrator, fallbackOrchestrator);
    assert.equal(clearSavedResumeCalls, 0);
    assert.deepEqual(dropSessionCalls, [{}]);
    assert.deepEqual(getOrCreateCalls, [{ userId: 8, cwd: "/mnt/d/code/ADS/ads", resumeThread: false }]);
    assert.deepEqual(saveThreadCalls, [{ userId: 8, threadId: "new-claude-session", agentId: "claude" }]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(sent.at(-1), {
      type: "history",
      items: [
        {
          role: "status",
          text: "已从最近任务恢复上下文：Recent Claude task",
          ts: historyEntries[0]?.ts,
        },
      ],
    });
  });
});
