import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleTaskResumeMessage } from "../../server/web/server/ws/handleTaskResume.js";

describe("web/ws/handleTaskResume", () => {
  const originalCodexBin = process.env.ADS_CODEX_BIN;

  // The disk probe reads the real provider homes otherwise: an empty but
  // readable root is what makes "session is gone" deterministic, since a
  // missing root probes as `unknown` and lets the resume through.
  before(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-resume-probe-"));
    fs.mkdirSync(path.join(root, "codex", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  });

  afterEach(() => {
    if (originalCodexBin === undefined) {
      delete process.env.ADS_CODEX_BIN;
      return;
    }
    process.env.ADS_CODEX_BIN = originalCodexBin;
  });

  it("does not consult the retired task context while resuming", async () => {
    const sent: unknown[] = [];
    const sessionSent: unknown[] = [];
    const historyEntries: { role: string; text: string; ts: number; kind?: string }[] = [];

    await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { mode: "auto" },
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
        broadcastJson: (payload: unknown) => sessionSent.push(payload),
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
        historyKey: "history-busy",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => undefined,
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => null,
        } as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          clear: () => {
            historyEntries.length = 0;
          },
          add: (_key: string, entry: { role: string; text: string; ts: number; kind?: string }) => {
            historyEntries.push(entry);
          },
          get: () => historyEntries,
        } as any,
      },
      tasks: {
        ensureTaskContext: () => {
          throw new Error("retired task context must not be accessed");
        },
      },
    } as any);

    assert.equal(sent.length, 0);
    assert.deepEqual(sessionSent, [{ type: "error", message: "未找到可用于恢复的任务历史" }]);
    assert.deepEqual(historyEntries, [
      { role: "status", text: "未找到可用于恢复的任务历史", ts: historyEntries[0]?.ts, kind: "error" },
    ]);
  });

  it("prefers current lane history over older task transcripts when thread resume is unavailable", async () => {
    const sent: unknown[] = [];
    const sessionSent: unknown[] = [];
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
      getActiveAgentId: () => "codex",
      getThreadId: () => "codex-current-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "new-codex-session",
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
        broadcastJson: (payload: unknown) => sessionSent.push(payload),
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
          getSavedThreadId: () => "codex-saved-thread",
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
                model: "gpt-codex",
                status: "completed",
                priority: 0,
                queueOrder: 0,
                inheritContext: false,
                agentId: null,
                retryCount: 0,
                maxRetries: 0,
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
    assert.deepEqual(saveThreadCalls, [{ userId: 9, threadId: "new-codex-session", agentId: "codex" }]);
    assert.equal(sent.length, 0);
    assert.deepEqual(sessionSent.at(-1), {
      type: "history",
      threadId: "new-codex-session",
      contextMode: "history_injection",
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
          text: "未能原生恢复（会话文件已不存在），已从当前对话恢复上下文",
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
    assert.deepEqual(historyEntries, [
      ...originalHistoryEntries,
      {
        role: "status",
        text: "恢复失败: restore exploded",
        ts: historyEntries.at(-1)?.ts,
        kind: "error",
      },
    ]);
    assert.deepEqual(sent, [{ type: "error", message: "恢复失败: restore exploded" }]);
  });

  it("persists a resume error when no context is available", async () => {
    const sent: unknown[] = [];
    const historyEntries: Array<{ role: string; text: string; ts: number; kind?: string }> = [];

    const initialOrchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => null,
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
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
        userId: 11,
        historyKey: "history-empty",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedState: () => ({ cwd: "/mnt/d/code/ADS/ads" }),
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => undefined,
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {},
          dropSession: () => {},
          getOrCreate: () => initialOrchestrator as any,
          saveThreadId: () => {},
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
          add: (_key: string, entry: { role: string; text: string; ts: number; kind?: string }) => {
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
    assert.deepEqual(historyEntries, [
      {
        role: "status",
        text: "未找到可用于恢复的任务历史",
        ts: historyEntries[0]?.ts,
        kind: "error",
      },
    ]);
    assert.deepEqual(sent, [{ type: "error", message: "未找到可用于恢复的任务历史" }]);
  });

  it("persists a resume error when fallback agent is not ready", async () => {
    const sent: unknown[] = [];
    const historyEntries = [
      { role: "user", text: "current question", ts: 1 },
      { role: "ai", text: "current answer", ts: 2 },
    ];
    const originalHistoryEntries = historyEntries.map((entry) => ({ ...entry }));

    const initialOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => "claude-current-thread",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
    };

    const fallbackOrchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => null,
      setWorkingDirectory: () => {},
      status: () => ({ ready: false, error: "Claude credentials are missing" }),
      send: async () => {
        throw new Error("should not send when agent is unavailable");
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
        userId: 12,
        historyKey: "history-agent-missing",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getSavedThreadId: () => "claude-saved-thread",
          getSavedResumeThreadId: () => undefined,
          getSandboxMode: () => "workspace-write",
          getCodexEnv: () => undefined,
          clearSavedResumeThreadId: () => {},
          dropSession: () => {},
          getOrCreate: () => fallbackOrchestrator as any,
          saveThreadId: () => {},
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
          add: (_key: string, entry: { role: string; text: string; ts: number; kind?: string }) => {
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
    assert.deepEqual(historyEntries, [
      ...originalHistoryEntries,
      {
        role: "status",
        text: "Claude credentials are missing",
        ts: historyEntries.at(-1)?.ts,
        kind: "error",
      },
    ]);
    assert.deepEqual(sent, [{ type: "error", message: "Claude credentials are missing" }]);
  });

  it("clears a saved resume thread without importing an unrelated task transcript", async () => {
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
          getSavedState: () => ({ cwd: "/mnt/d/code/ADS/ads" }),
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
    assert.equal(result.orchestrator, initialOrchestrator);
    // The rollout file for `saved-resume-thread` does not exist, so the probe is
    // definitive and the dead id is dropped instead of being retried forever.
    assert.equal(clearSavedResumeCalls, 1);
    assert.deepEqual(dropSessionCalls, []);
    assert.deepEqual(getOrCreateCalls, []);
    assert.deepEqual(saveThreadCalls, []);
    assert.deepEqual(sent.at(-1), {
      type: "error",
      message: "未能原生恢复（会话文件已不存在），且未找到可用于恢复的任务历史",
    });
  });

  it("does not attempt native resume for a legacy Claude marker", async () => {
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
    assert.equal(result.orchestrator, initialOrchestrator);
    assert.equal(clearSavedResumeCalls, 0);
    assert.deepEqual(dropSessionCalls, []);
    assert.deepEqual(getOrCreateCalls, []);
    assert.deepEqual(saveThreadCalls, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /restore=unavailable/);
    assert.deepEqual(sent.at(-1), {
      type: "error",
      message: "未找到可用于恢复的任务历史",
    });
  });

  it("keeps the plain wording when there was no native session to try", async () => {
    const sessionSent: unknown[] = [];
    const historyEntries = [
      { role: "user", text: "current question", ts: 1 },
      { role: "ai", text: "current answer", ts: 2 },
    ];

    const orchestrator = {
      getActiveAgentId: () => "claude",
      getThreadId: () => null,
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async () => ({ output: "OK" }),
    };

    await handleTaskResumeMessage({
      request: { parsed: { type: "task_resume", payload: { mode: "auto" } } as any },
      transport: {
        ws: {} as any,
        safeJsonSend: () => {},
        broadcastJson: (payload: unknown) => sessionSent.push(payload),
      },
      observability: { logger: { info: () => {}, debug: () => {}, warn: () => {} } },
      context: { userId: 11, historyKey: "history-plain", currentCwd: "/mnt/d/code/ADS/ads" },
      sessions: {
        sessionManager: {
          // Nothing saved anywhere, so the native path is never entered.
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => undefined,
          clearSavedResumeThreadId: () => {},
          dropSession: () => {},
          getOrCreate: () => orchestrator as any,
          saveThreadId: () => {},
        } as any,
        orchestrator: orchestrator as any,
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
          taskStore: { getActiveTaskId: () => null },
        }) as any,
      },
    } as any);

    const history = sessionSent.at(-1) as { items: Array<{ role: string; text: string }> };
    assert.equal(history.items.at(-1)?.text, "已从当前对话恢复上下文");
  });
});
