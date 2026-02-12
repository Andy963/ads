import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleCommandMessage } from "../../src/web/server/ws/handleCommand.js";
import { handlePromptMessage } from "../../src/web/server/ws/handlePrompt.js";

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
    await handlePromptMessage({
      parsed: { type: "prompt", payload },
      ws: {} as any,
      safeJsonSend: (_ws, payload) => clientMessages.push(payload),
      broadcastJson: (payload) => chatMessages.push(payload),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: () => {},
        logEvent: () => {},
        attachThreadId: () => {},
      },
      requestId: "req",
      clientMessageId: null,
      traceWsDuplication: false,
      authUserId: "test",
      sessionId: "s",
      chatSessionId: "main",
      userId: 1,
      historyKey: "h",
      currentCwd: workspaceRoot,
      allowedDirs: [workspaceRoot],
      getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      interruptControllers: new Map(),
      historyStore: historyStore as any,
      sessionManager: {
        getOrCreate: () => orchestrator as any,
        getSavedThreadId: () => undefined,
        needsHistoryInjection: () => false,
        clearHistoryInjection: () => {},
        saveThreadId: () => {},
      } as any,
      orchestrator: orchestrator as any,
      sendWorkspaceState: () => {},
    });
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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: "/search hello world" },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {} as any,
        agentAvailability: {} as any,
        historyStore: historyStore as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: "/bootstrap some repo goal" },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {} as any,
        agentAvailability: {} as any,
        historyStore: historyStore as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: "/vsearch hello world" },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {} as any,
        agentAvailability: {} as any,
        historyStore: historyStore as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: "/review looks good" },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {} as any,
        agentAvailability: {} as any,
        historyStore: historyStore as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: "/ads.status" },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {} as any,
        agentAvailability: {} as any,
        historyStore: historyStore as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: { command: "/cd next", silent: true } as any },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {
          setUserCwd: (_userId: number, _targetPath: string) => {
            setUserCwdCalled += 1;
            cwd = nextCwd;
            return { success: true };
          },
          getUserCwd: () => cwd,
        } as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {
          setUserCwd: (_userId: number, value: string) => {
            sessionManagerCwd = value;
          },
          getOrCreate: () => new FakeOrchestrator() as any,
          getSavedThreadId: () => undefined,
        } as any,
        agentAvailability: {} as any,
        historyStore: new MemoryHistoryStore() as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: (_ws: any, root: string) => clientMessages.push({ type: "workspace", root }),
        syncWorkspaceTemplates: () => {
          syncCalled += 1;
        },
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

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

  it("supports silent /agent routing commands", async () => {
    await withTempWorkspace("ads-web-ws-command-agent-", async (workspaceRoot) => {
      const clientMessages: unknown[] = [];
      const chatMessages: unknown[] = [];
      let called = false;

      const result = await handleCommandMessage({
        parsed: { type: "command", payload: { command: "/agent", silent: true } as any },
        ws: {} as any,
        safeJsonSend: (_ws, payload) => clientMessages.push(payload),
        broadcastJson: (payload) => chatMessages.push(payload),
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: null,
        requestId: "req",
        sessionId: "s",
        userId: 1,
        historyKey: "h",
        clientMessageId: null,
        traceWsDuplication: false,
        directoryManager: {} as any,
        cacheKey: "k",
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
        sessionManager: {
          getOrCreate: () => new FakeOrchestrator() as any,
          getSavedThreadId: () => undefined,
        } as any,
        agentAvailability: { mergeStatus: (_agentId: string, status: any) => status } as any,
        historyStore: new MemoryHistoryStore() as any,
        interruptControllers: new Map(),
        runAdsCommandLine: async () => {
          called = true;
          return { ok: true, output: "unexpected" };
        },
        sendWorkspaceState: () => {},
        syncWorkspaceTemplates: () => {},
        sanitizeInput: (payload) => {
          if (typeof payload === "string") return payload;
          if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
            return String((payload as Record<string, unknown>).command ?? "");
          }
          return "";
        },
        currentCwd: workspaceRoot,
        orchestrator: {} as any,
        getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
      });

      assert.equal(result.handled, true);
      assert.equal(called, false);
      assert.equal(chatMessages.length, 0);
      assert.equal(clientMessages.length, 1);
      assert.equal((clientMessages[0] as { type?: unknown }).type, "agents");
    });
  });
});
