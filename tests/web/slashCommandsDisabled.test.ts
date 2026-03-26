import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleCommandMessage } from "../../server/web/server/ws/handleCommand.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    const list = this.store.get(sessionId) ?? [];
    list.push(entry);
    this.store.set(sessionId, list);
    return true;
  }

  clear(sessionId: string): void {
    this.store.delete(sessionId);
  }
}

function inputToText(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const rec = part as { type?: unknown; text?: unknown; path?: unknown };
        if (rec.type === "text") return String(rec.text ?? "");
        if (rec.type === "local_image") return `[image:${String(rec.path ?? "")}]`;
        return `[${String(rec.type ?? "unknown")}]`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(input ?? "");
}

class FakeOrchestrator {
  lastInvokeInput: unknown = null;

  status(): { ready: boolean; error?: string; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(_workingDirectory?: string): void {
    // noop
  }

  getActiveAgentId(): string {
    return "codex";
  }

  listAgents(): Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean; error?: string } }> {
    return [
      {
        metadata: { id: "codex", name: "Codex" },
        status: { ready: true, streaming: true },
      },
    ];
  }

  hasAgent(agentId: string): boolean {
    return agentId === "codex";
  }

  onEvent(_handler: (event: unknown) => void): () => void {
    return () => undefined;
  }

  async invokeAgent(agentId: string, input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.lastInvokeInput = input;
    return { response: "stub response", usage: null, agentId };
  }

  getThreadId(): string {
    return "thread-test";
  }
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withTempWorkspace(prefix: string, fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = createTempDir(prefix);
  try {
    await fn(workspaceRoot);
  } finally {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function sanitizeCommandPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
    return String((payload as Record<string, unknown>).command ?? "");
  }
  return "";
}

function createPromptDeps(args: {
  payload: string;
  workspaceRoot: string;
  chatMessages: unknown[];
  clientMessages: unknown[];
  historyStore: MemoryHistoryStore;
  orchestrator: FakeOrchestrator;
}) {
  return {
    request: {
      parsed: { type: "prompt" as const, payload: args.payload },
      requestId: "req",
      clientMessageId: null,
      receivedAt: Date.now(),
    },
    transport: {
      ws: {} as any,
      safeJsonSend: (_ws: unknown, payload: unknown) => args.clientMessages.push(payload),
      broadcastJson: (payload: unknown) => args.chatMessages.push(payload),
      sendWorkspaceState: () => {},
    },
    observability: {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: () => {},
        logEvent: () => {},
        attachThreadId: () => {},
      },
      traceWsDuplication: false,
    },
    context: {
      authUserId: "test",
      sessionId: "s",
      chatSessionId: "main" as const,
      userId: 1,
      historyKey: "h",
      currentCwd: args.workspaceRoot,
    },
    sessions: {
      sessionManager: {
        getOrCreate: () => args.orchestrator as any,
        getSavedThreadId: () => undefined,
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        saveThreadId: () => {},
      } as any,
      orchestrator: args.orchestrator as any,
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map<string, AbortController>(),
    },
    history: {
      historyStore: args.historyStore as any,
    },
    tasks: {},
    scheduler: {},
  };
}

function createCommandDeps(args: {
  parsed: { type: "command" | "set_agent"; payload: unknown };
  workspaceRoot: string;
  clientMessages: unknown[];
  chatMessages: unknown[];
  historyStore?: MemoryHistoryStore;
  sessionManager?: Record<string, unknown>;
  orchestrator?: unknown;
  directoryManager?: unknown;
  agentAvailability?: unknown;
  runAdsCommandLine?: (command: string) => Promise<{ ok: boolean; output: string }>;
  sendWorkspaceState?: (_ws: unknown, root: string) => void;
  syncWorkspaceTemplates?: () => void;
}) {
  return {
    request: {
      parsed: args.parsed,
      clientMessageId: null,
    },
    transport: {
      ws: {} as any,
      safeJsonSend: (_ws: unknown, payload: unknown) => args.clientMessages.push(payload),
      broadcastJson: (payload: unknown) => args.chatMessages.push(payload),
      sendWorkspaceState: args.sendWorkspaceState ?? (() => {}),
    },
    observability: {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: null,
      traceWsDuplication: false,
    },
    context: {
      sessionId: "s",
      userId: 1,
      historyKey: "h",
      currentCwd: args.workspaceRoot,
    },
    agents: {
      agentAvailability: (args.agentAvailability ?? {}) as any,
    },
    state: {
      directoryManager: (args.directoryManager ?? {}) as any,
      cacheKey: "k",
      workspaceCache: new Map(),
      cwdStore: new Map(),
      cwdStorePath: "",
      persistCwdStore: () => {},
    },
    sessions: {
      sessionManager: (args.sessionManager ?? {}) as any,
      orchestrator: (args.orchestrator ?? ({} as any)) as any,
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map<string, AbortController>(),
    },
    history: {
      historyStore: (args.historyStore ?? new MemoryHistoryStore()) as any,
    },
    commands: {
      runAdsCommandLine: args.runAdsCommandLine ?? (async () => ({ ok: true, output: "" })),
      sanitizeInput: sanitizeCommandPayload,
      syncWorkspaceTemplates: args.syncWorkspaceTemplates ?? (() => {}),
    },
  };
}

async function runPromptThrough(payload: string): Promise<{
  chatMessages: unknown[];
  clientMessages: unknown[];
  orchestrator: FakeOrchestrator;
}> {
  const chatMessages: unknown[] = [];
  const clientMessages: unknown[] = [];
  const orchestrator = new FakeOrchestrator();
  const historyStore = new MemoryHistoryStore();

  await withTempWorkspace("ads-web-prompt-", async (workspaceRoot) => {
    await handlePromptMessage(
      createPromptDeps({
        payload,
        workspaceRoot,
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
      }),
    );
  });

  return { chatMessages, clientMessages, orchestrator };
}

describe("web slash commands", () => {
  it("treats /search as normal prompt text", async () => {
    const { chatMessages, clientMessages, orchestrator } = await runPromptThrough("/search hello world");
    assert.match(inputToText(orchestrator.lastInvokeInput), /\/search hello world/);
    assert.ok(
      chatMessages.some(
        (msg) => (msg as { type?: unknown; output?: unknown }).type === "result" && (msg as { output?: unknown }).output === "stub response",
      ),
    );
    assert.ok(!chatMessages.some((msg) => JSON.stringify(msg).includes("/search <query>")));
    assert.ok(!clientMessages.some((msg) => JSON.stringify(msg).includes("/search <query>")));
  });

  it("treats /bootstrap as normal prompt text", async () => {
    const { chatMessages, clientMessages, orchestrator } = await runPromptThrough("/bootstrap some repo goal");
    assert.match(inputToText(orchestrator.lastInvokeInput), /\/bootstrap some repo goal/);
    assert.ok(
      chatMessages.some(
        (msg) => (msg as { type?: unknown; output?: unknown }).type === "result" && (msg as { output?: unknown }).output === "stub response",
      ),
    );
    assert.ok(!chatMessages.some((msg) => (msg as { kind?: unknown }).kind === "bootstrap"));
    assert.ok(!clientMessages.some((msg) => (msg as { kind?: unknown }).kind === "bootstrap"));
  });

  it("treats /vsearch as normal prompt text", async () => {
    const { chatMessages, orchestrator } = await runPromptThrough("/vsearch hello world");
    assert.match(inputToText(orchestrator.lastInvokeInput), /\/vsearch hello world/);
    assert.ok(
      chatMessages.some(
        (msg) => (msg as { type?: unknown; output?: unknown }).type === "result" && (msg as { output?: unknown }).output === "stub response",
      ),
    );
  });

  it("treats /ads.* as normal prompt text", async () => {
    const { chatMessages, orchestrator } = await runPromptThrough("/ads.status");
    assert.match(inputToText(orchestrator.lastInvokeInput), /\/ads\.status/);
    assert.ok(
      chatMessages.some(
        (msg) => (msg as { type?: unknown; output?: unknown }).type === "result" && (msg as { output?: unknown }).output === "stub response",
      ),
    );
  });

  it("treats /review as normal prompt text", async () => {
    const { chatMessages, orchestrator } = await runPromptThrough("/review looks good");
    assert.match(inputToText(orchestrator.lastInvokeInput), /\/review looks good/);
    assert.ok(
      chatMessages.some(
        (msg) => (msg as { type?: unknown; output?: unknown }).type === "result" && (msg as { output?: unknown }).output === "stub response",
      ),
    );
  });

  it("does not route /search over ws command messages", async () => {
    await withTempWorkspace("ads-web-ws-command-search-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      const historyStore = new MemoryHistoryStore();
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: "/search hello world" },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(clientMessages.length, 0);
      assert.equal(chatMessages.length, 0);
    });
  });

  it("does not route /bootstrap over ws command messages", async () => {
    await withTempWorkspace("ads-web-ws-command-bootstrap-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      const historyStore = new MemoryHistoryStore();
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: "/bootstrap some repo goal" },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(clientMessages.length, 0);
      assert.equal(chatMessages.length, 0);
    });
  });

  it("does not route /vsearch over ws command messages", async () => {
    await withTempWorkspace("ads-web-ws-command-vsearch-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      const historyStore = new MemoryHistoryStore();
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: "/vsearch hello world" },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(clientMessages.length, 0);
      assert.equal(chatMessages.length, 0);
    });
  });

  it("does not route /review over ws command messages", async () => {
    await withTempWorkspace("ads-web-ws-command-review-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      const historyStore = new MemoryHistoryStore();
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: "/review looks good" },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(clientMessages.length, 0);
      assert.equal(chatMessages.length, 0);
    });
  });

  it("does not route /ads.* over ws command messages", async () => {
    await withTempWorkspace("ads-web-ws-command-ads-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      const historyStore = new MemoryHistoryStore();
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: "/ads.status" },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(clientMessages.length, 0);
      assert.equal(chatMessages.length, 0);
    });
  });

  it("supports silent /cd routing commands", async () => {
    await withTempWorkspace("ads-web-ws-command-cd-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];

      const nextCwd = path.join(workspaceRoot, "next");
      let cwd = workspaceRoot;
      let syncCalled = 0;
      let setUserCwdCalled = 0;
      let sessionManagerCwd: string | null = null;
      let called = false;

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "command", payload: { command: "/cd next", silent: true } as any },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore: new MemoryHistoryStore(),
          directoryManager: {
            setUserCwd: (_userId: number, _targetPath: string) => {
              setUserCwdCalled += 1;
              cwd = nextCwd;
              return { success: true };
            },
            getUserCwd: () => cwd,
          } as any,
          sessionManager: {
            setUserCwd: (_userId: number, value: string) => {
              sessionManagerCwd = value;
            },
            getOrCreate: () => new FakeOrchestrator() as any,
            getSavedThreadId: () => undefined,
          } as any,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
          sendWorkspaceState: (_ws: unknown, root: string) => clientMessages.push({ type: "workspace", root }),
          syncWorkspaceTemplates: () => {
            syncCalled += 1;
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(result.currentCwd, nextCwd);
      assert.equal(sessionManagerCwd, nextCwd);
      assert.equal(setUserCwdCalled, 1);
      assert.equal(syncCalled, 1);
      assert.equal(chatMessages.length, 0);
      assert.deepEqual(clientMessages, [{ type: "workspace", root: nextCwd }]);
    });
  });

  it("supports set_agent control messages", async () => {
    await withTempWorkspace("ads-web-ws-command-agent-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      let called = false;
      let switched: { userId: number; agentId: string } | null = null;
      const orchestrator = new FakeOrchestrator();

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "set_agent", payload: { agentId: "codex" } as any },
          workspaceRoot,
          clientMessages,
          chatMessages,
          historyStore: new MemoryHistoryStore(),
          sessionManager: {
            switchAgent: (userId: number, agentId: string) => {
              switched = { userId, agentId };
              return { success: true, message: "ok" };
            },
            getOrCreate: () => orchestrator as any,
            getSavedThreadId: () => undefined,
          } as any,
          orchestrator: {} as any,
          agentAvailability: { mergeStatus: (_agentId: string, status: any) => status } as any,
          runAdsCommandLine: async () => {
            called = true;
            return { ok: true, output: "unexpected" };
          },
        }),
      );

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(chatMessages.length, 0);
      assert.deepEqual(switched, { userId: 1, agentId: "codex" });
      assert.equal(clientMessages.length, 1);
      assert.equal((clientMessages[0] as { type?: unknown }).type, "agents");
    });
  });

  it("returns an error when set_agent targets an unassembled agent", async () => {
    await withTempWorkspace("ads-web-ws-command-agent-error-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];

      const result = await handleCommandMessage(
        createCommandDeps({
          parsed: { type: "set_agent", payload: { agentId: "claude" } as any },
          workspaceRoot,
          clientMessages,
          chatMessages: [],
          historyStore: new MemoryHistoryStore(),
          sessionManager: {
            switchAgent: () => ({ success: false, message: '❌ Agent "claude" is not registered' }),
          } as any,
          orchestrator: {} as any,
          agentAvailability: { mergeStatus: (_agentId: string, status: any) => status } as any,
        }),
      );

      assert.equal(result.handled, true);
      assert.deepEqual(clientMessages, [{ type: "error", message: '❌ Agent "claude" is not registered' }]);
    });
  });
});
