import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleTaskResumeMessage } from "../../server/web/server/ws/handleTaskResume.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { HistoryStore } from "../../server/utils/historyStore.js";

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

  function buildNativeResumeDeps(args: {
    historyStore: unknown;
    historyKey: string;
    userId: number;
    orchestrator?: Record<string, unknown>;
    send?: (prompt: string) => Promise<unknown>;
    sent: unknown[];
    threadId?: string;
  }): { deps: any; state: { resumeFlags: boolean[]; drops: number; sends: number } } {
    const state = { resumeFlags: [] as boolean[], drops: 0, sends: 0 };
    const orchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "native-current-execution",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      ...args.orchestrator,
      send: async (...sendArgs: unknown[]) => {
        state.sends += 1;
        return args.send ? await args.send(String(sendArgs[0] ?? "")) : { output: "OK" };
      },
    };
    const deps = {
      request: {
        parsed: {
          type: "task_resume",
          payload: args.threadId ? { threadId: args.threadId } : {},
        } as any,
      },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => args.sent.push(payload),
        broadcastJson: (payload: unknown) => args.sent.push(payload),
      },
      observability: { logger: { info: () => {}, debug: () => {}, warn: () => {} } },
      context: {
        authUserId: args.historyKey.split("::", 1)[0],
        userId: args.userId,
        historyKey: args.historyKey,
        currentCwd: "/repo",
      },
      sessions: {
        sessionManager: {
          getRuntimeBackend: () => "native",
          getSavedState: () => ({ runtimeBackend: "native", cwd: "/repo" }),
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => undefined,
          getContextRestoreMode: () => "thread_resumed",
          dropSession: () => {
            state.drops += 1;
          },
          getOrCreate: (_userId: number, _cwd: string | undefined, resumeThread: boolean) => {
            state.resumeFlags.push(resumeThread);
            return orchestrator;
          },
        },
        orchestrator,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }),
      },
      history: { historyStore: args.historyStore },
    };
    return { deps, state };
  }

  it("rejects a Native history link owned by another user", async () => {
    const sent: unknown[] = [];
    const historyEntries = [{ role: "user", text: "current question", ts: 1 }];
    const orchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "native-current-execution",
    };

    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { threadId: "codex-provider-thread" },
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
        authUserId: "user-9",
        userId: 9,
        historyKey: "user-9::session-1::actions",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getRuntimeBackend: () => "native",
        } as any,
        orchestrator: orchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          get: () => historyEntries,
          listAgentSessionLinks: () => [{
            historyKey: "user-10::session-2::actions",
            agentId: "codex",
            providerSessionId: "codex-provider-thread",
            cwd: "/mnt/d/code/ADS/ads",
            firstSeenAt: 1,
            lastSeenAt: 2,
            linkCount: 1,
          }],
        } as any,
      },
    });

    assert.equal(result.handled, true);
    assert.deepEqual(sent, [{
      type: "error",
      message: "Selected session has no ADS history to restore",
    }]);
    assert.deepEqual(historyEntries, [{ role: "user", text: "current question", ts: 1 }]);
  });

  it("asks the user to switch workspaces instead of reporting missing history", async () => {
    const sent: unknown[] = [];
    const harness = buildNativeResumeDeps({
      historyStore: {
        get: () => [{ role: "user", text: "elsewhere", ts: 1 }],
        listAgentSessionLinks: () => [{
          historyKey: "user-21::session-2::actions",
          agentId: "codex",
          providerSessionId: "thread-other",
          cwd: "/other",
          firstSeenAt: 1,
          lastSeenAt: 2,
          linkCount: 1,
        }],
      },
      historyKey: "user-21::session-1::actions",
      userId: 21,
      sent,
      threadId: "thread-other",
    });

    await handleTaskResumeMessage(harness.deps);

    assert.deepEqual(sent, [{
      type: "error",
      message: "Selected session belongs to another workspace (/other). Switch to that workspace before restoring it.",
    }]);
  });

  it("restores a selected Native conversation from its linked HistoryStore transcript", async () => {
    const sent: unknown[] = [];
    const currentHistory = [{ role: "user", text: "current conversation", ts: 1 }];
    const selectedHistory = [
      { role: "user", text: "saved question", ts: 2 },
      { role: "ai", text: "saved answer", ts: 3 },
    ];
    const histories = new Map([
      ["user-12::session-current::actions", currentHistory],
      ["user-12::session-saved::actions", selectedHistory],
    ]);
    const prompts: string[] = [];
    const orchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "native-current-execution",
      setWorkingDirectory: () => {},
      status: () => ({ ready: true }),
      send: async (prompt: string) => {
        prompts.push(prompt);
        return { output: "OK" };
      },
    };

    await handleTaskResumeMessage({
      request: { parsed: { type: "task_resume", payload: { threadId: "codex-provider-thread" } } as any },
      transport: {
        ws: {} as any,
        safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload),
        broadcastJson: (payload: unknown) => sent.push(payload),
      },
      observability: { logger: { info: () => {}, debug: () => {}, warn: () => {} } },
      context: {
        authUserId: "user-12",
        userId: 12,
        historyKey: "user-12::session-current::actions",
        currentCwd: "/repo",
      },
      sessions: {
        sessionManager: {
          getRuntimeBackend: () => "native",
          getSavedState: () => ({ runtimeBackend: "native", cwd: "/repo" }),
          getSavedThreadId: () => undefined,
          getSavedResumeThreadId: () => undefined,
          dropSession: () => {},
          getOrCreate: () => orchestrator as any,
        } as any,
        orchestrator: orchestrator as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          get: (key: string) => histories.get(key) ?? [],
          listAgentSessionLinks: () => [{
            agentId: "codex",
            providerSessionId: "codex-provider-thread",
            historyKey: "user-12::session-saved::actions",
            cwd: "/repo",
            firstSeenAt: 2,
            lastSeenAt: 3,
            linkCount: 1,
          }],
          replaceEntries: (key: string, entries: typeof currentHistory) => {
            histories.set(key, entries);
            return true;
          },
        } as any,
      },
    } as any);

    assert.match(prompts[0], /User: saved question/);
    assert.match(prompts[0], /Assistant: saved answer/);
    assert.deepEqual(histories.get("user-12::session-saved::actions"), selectedHistory);
    assert.ok(histories.get("user-12::session-current::actions")?.some((entry) => entry.kind === "session_divider"));
    assert.ok(sent.some((payload) => (payload as { type?: string }).type === "history"));
  });

  it("reattaches the durable native transcript instead of resetting the lane", async () => {
    const sent: unknown[] = [];
    const entries: Array<{ role: string; text: string; ts: number }> = [
      { role: "user", text: "current question", ts: 1 },
    ];
    const harness = buildNativeResumeDeps({
      historyStore: {
        get: () => entries,
        clear: () => {
          entries.length = 0;
        },
        add: (_key: string, entry: { role: string; text: string; ts: number }) => {
          entries.push(entry);
          return true;
        },
      },
      historyKey: "user-20::session-1::actions",
      userId: 20,
      sent,
    });

    const result = await handleTaskResumeMessage(harness.deps);

    assert.equal(result.handled, true);
    assert.equal(harness.state.drops, 0);
    assert.deepEqual(harness.state.resumeFlags, [true]);
    assert.equal(harness.state.sends, 0);
    const history = sent.find((payload) => (payload as { type?: string }).type === "history") as
      | { contextMode?: string; items?: Array<{ text: string }> }
      | undefined;
    assert.equal(history?.contextMode, "thread_resumed");
    assert.deepEqual(history?.items?.map((item) => item.text), [
      "current question",
      "已恢复会话记录",
    ]);
  });

  it("reattaches the lane's own Native session without resetting its transcript", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-resume-self-"));
    const store = new HistoryStore({ namespace: "web-worker", storagePath: path.join(dir, "state.db") });
    try {
      const historyKey = "user-30::session-1::actions";
      store.add(historyKey, { role: "user", text: "question one", ts: 1, kind: "client_message_id:m1" });
      store.add(historyKey, { role: "ai", text: "answer one", ts: 2 });
      store.add(historyKey, { role: "user", text: "question two", ts: 3, kind: "client_message_id:m2" });
      store.add(historyKey, { role: "ai", text: "answer two", ts: 4 });
      store.linkAgentSession(historyKey, { agentId: "codex", providerSessionId: "thread-self", cwd: "/repo" });

      const harness = buildNativeResumeDeps({
        historyStore: store,
        historyKey,
        userId: 30,
        sent: [],
        threadId: "thread-self",
      });
      await handleTaskResumeMessage(harness.deps);

      assert.equal(harness.state.drops, 0);
      assert.deepEqual(harness.state.resumeFlags, [true]);
      const entries = store.get(historyKey);
      assert.deepEqual(
        entries.filter((entry) => entry.role === "ai").map((entry) => entry.text),
        ["answer one", "answer two"],
      );
      assert.deepEqual(
        entries.filter((entry) => entry.role === "user").map((entry) => entry.text),
        ["question one", "question two"],
      );
      assert.equal(entries.some((entry) => entry.kind === "session_divider"), false);
      assert.equal(entries.at(-1)?.text, "已恢复会话记录");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one copy when the same conversation is restored twice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-resume-repeat-"));
    const store = new HistoryStore({ namespace: "web-worker", storagePath: path.join(dir, "state.db") });
    try {
      const sourceKey = "user-31::session-saved::actions";
      const targetKey = "user-31::session-current::actions";
      store.add(sourceKey, { role: "user", text: "saved question", ts: 1, kind: "client_message_id:m9" });
      store.add(sourceKey, { role: "ai", text: "saved answer", ts: 2 });
      store.linkAgentSession(sourceKey, { agentId: "codex", providerSessionId: "thread-saved", cwd: "/repo" });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const harness = buildNativeResumeDeps({
          historyStore: store,
          historyKey: targetKey,
          userId: 31,
          sent: [],
          threadId: "thread-saved",
        });
        await handleTaskResumeMessage(harness.deps);
      }

      const target = store.get(targetKey);
      assert.equal(target.filter((entry) => entry.role === "ai").length, 1);
      assert.equal(target.filter((entry) => entry.role === "user").length, 1);
      assert.equal(target.filter((entry) => entry.kind === "session_divider").length, 1);
      assert.equal(
        target.some((entry) => String(entry.kind ?? "").startsWith("client_message_id:")),
        false,
      );
      assert.deepEqual(
        store.get(sourceKey).map((entry) => entry.text),
        ["saved question", "saved answer"],
      );
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a Native execution alias for the Codex runtime backend", async () => {
    const sent: unknown[] = [];
    const historyEntries = [{ role: "user", text: "current question", ts: 1 }];
    const result = await handleTaskResumeMessage({
      request: {
        parsed: {
          type: "task_resume",
          payload: { threadId: "native-execution-id" },
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
        historyKey: "history-codex-native-alias",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getRuntimeBackend: () => "codex-app-server",
        } as any,
        orchestrator: {
          getActiveAgentId: () => "codex",
          getThreadId: () => "codex-provider-thread",
        } as any,
        getWorkspaceLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      },
      history: {
        historyStore: {
          get: () => historyEntries,
        } as any,
      },
    });

    assert.equal(result.handled, true);
    assert.deepEqual(sent, [{
      type: "error",
      message: "Native execution IDs cannot be resumed as provider threads",
    }]);
    assert.deepEqual(historyEntries, [{ role: "user", text: "current question", ts: 1 }]);
  });

  it("rejects a Native execution alias selected from current or saved resume candidates", async () => {
    const candidates = [
      {
        currentThreadId: "native-current-execution",
        savedThreadId: "codex-saved-thread",
        savedResumeThreadId: "codex-saved-resume",
      },
      {
        currentThreadId: null,
        savedThreadId: "native-saved-execution",
        savedResumeThreadId: "codex-saved-resume",
      },
      {
        currentThreadId: null,
        savedThreadId: undefined,
        savedResumeThreadId: "native-saved-resume",
      },
    ];

    for (const candidate of candidates) {
      const sent: unknown[] = [];
      const historyEntries = [{ role: "user", text: "current question", ts: 1 }];
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
          userId: 20,
          historyKey: "history-codex-native-candidate",
          currentCwd: "/mnt/d/code/ADS/ads",
        },
        sessions: {
          sessionManager: {
            getRuntimeBackend: () => "codex-app-server",
            getSavedThreadId: () => candidate.savedThreadId,
            getSavedResumeThreadId: () => candidate.savedResumeThreadId,
          } as any,
          orchestrator: {
            getActiveAgentId: () => "codex",
            getThreadId: () => candidate.currentThreadId,
            status: () => {
              throw new Error("Native aliases must be rejected before provider probing");
            },
          } as any,
          getWorkspaceLock: () => ({
            runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
          }) as any,
        },
        history: {
          historyStore: {
            get: () => historyEntries,
          } as any,
        },
      });

      assert.equal(result.handled, true);
      assert.deepEqual(sent, [{
        type: "error",
        message: "Native execution IDs cannot be resumed as provider threads",
      }]);
      assert.deepEqual(historyEntries, [{ role: "user", text: "current question", ts: 1 }]);
    }
  });

  it("reports a persisted runtime backend mismatch before resume selection or fallback", async () => {
    const sent: unknown[] = [];
    const historyEntries = [{ role: "user", text: "current question", ts: 1 }];
    let getOrCreateCalls = 0;
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
        userId: 21,
        historyKey: "history-runtime-mismatch",
        currentCwd: "/mnt/d/code/ADS/ads",
      },
      sessions: {
        sessionManager: {
          getRuntimeBackend: () => "codex-app-server",
          getSavedState: () => ({
            cwd: "/mnt/d/code/ADS/ads",
            runtimeBackend: "native",
            lifecycle: "durable",
          }),
          getSavedThreadId: () => {
            throw new Error("thread selection must not run after a backend mismatch");
          },
          getSavedResumeThreadId: () => {
            throw new Error("resume selection must not run after a backend mismatch");
          },
          getOrCreate: () => {
            getOrCreateCalls += 1;
            throw new Error("fallback must not run after a backend mismatch");
          },
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
          get: () => historyEntries,
        } as any,
      },
    });

    assert.equal(result.handled, true);
    assert.equal(getOrCreateCalls, 0);
    assert.deepEqual(sent, [{
      type: "error",
      code: "runtime_backend_mismatch",
      message:
        'Persisted session runtime backend "native" does not match the active runtime backend "codex-app-server". ' +
        "Cross-runtime resume is not supported.",
      savedBackend: "native",
      currentBackend: "codex-app-server",
    }]);
    assert.deepEqual(historyEntries, [{ role: "user", text: "current question", ts: 1 }]);
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
          getRuntimeBackend: () => "codex-app-server",
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
