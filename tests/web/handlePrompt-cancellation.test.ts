import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { abortInFlightHistory } from "../../server/web/server/ws/connectionRuntime.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    const next = [...this.get(sessionId), entry];
    this.store.set(sessionId, next);
    return true;
  }
}

class SlowOrchestrator {
  workingDirectory = "";
  private resolveInvoke: ((value: { response: string; usage: null; agentId: string }) => void) | null = null;
  private readonly startedPromise: Promise<void>;
  private startedResolve: (() => void) | null = null;

  constructor(private readonly threadId: string) {
    this.startedPromise = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  status(): { ready: boolean; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd;
  }

  setModel(): void {}

  setModelReasoningEffort(): void {}

  getActiveAgentId(): string {
    return "codex";
  }

  listAgents(): Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }> {
    return [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }];
  }

  hasAgent(agentId: string): boolean {
    return agentId === "codex";
  }

  onEvent(): () => void {
    return () => undefined;
  }

  getThreadId(): string {
    return this.threadId;
  }

  async invokeAgent(_agentId: string, _input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.startedResolve?.();
    return await new Promise<{ response: string; usage: null; agentId: string }>((resolve) => {
      this.resolveInvoke = resolve;
    });
  }

  waitForStart(): Promise<void> {
    return this.startedPromise;
  }

  resolveLate(response: string): void {
    this.resolveInvoke?.({ response, usage: null, agentId: "codex" });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("web/server/ws handlePrompt cancellation", () => {
  it("interrupt makes late prompt completion unable to write back output, history, or thread state", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-prompt-cancel-"));
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const interruptControllers = new Map<string, AbortController>();
    const promptRunEpochs = new Map<string, number>();
    const saveThreadIdCalls: Array<{ userId: number; threadId: string; agentId: string }> = [];
    const orchestrator = new SlowOrchestrator("late-thread");

    try {
      const pending = handlePromptMessage({
        request: {
          parsed: { type: "prompt", payload: "hello" },
          requestId: "req-1",
          clientMessageId: null,
          receivedAt: Date.now(),
        },
        transport: {
          ws: {} as any,
          safeJsonSend: (_ws, payload) => clientMessages.push(payload),
          broadcastJson: (payload) => chatMessages.push(payload),
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
          authUserId: "test-user",
          sessionId: "session-1",
          chatSessionId: "main",
          userId: 1,
          historyKey: "history-1",
          currentCwd: workspaceRoot,
        },
        sessions: {
          sessionManager: {
            getOrCreate: () => orchestrator as any,
            getSavedThreadId: () => undefined,
            getEffectiveState: () => ({ model: "test-model", modelReasoningEffort: "high", activeAgentId: "codex" }),
            needsHistoryInjection: () => false,
            clearHistoryInjection: () => {},
            saveThreadId: (userId: number, threadId: string, agentId: string) =>
              saveThreadIdCalls.push({ userId, threadId, agentId }),
            setUserModel: () => {},
            setUserModelReasoningEffort: () => {},
          } as any,
          orchestrator: orchestrator as any,
          getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }) as any,
          interruptControllers,
          promptRunEpochs,
        },
        history: {
          historyStore: historyStore as any,
        },
        tasks: {},
        scheduler: {},
      } as any);

      await orchestrator.waitForStart();
      assert.equal(
        abortInFlightHistory({
          interruptControllers,
          promptRunEpochs,
          historyKey: "history-1",
        }),
        true,
      );

      const settled = await Promise.race([
        pending.then(() => "done"),
        delay(200).then(() => "timeout"),
      ]);
      assert.equal(settled, "done");

      orchestrator.resolveLate("late output that must be ignored");
      await delay(0);

      assert.ok(chatMessages.some((msg) => (msg as { type?: unknown; message?: unknown }).message === "已中断，输出可能不完整"));
      assert.equal(
        chatMessages.some(
          (msg) =>
            (msg as { type?: unknown; output?: unknown }).type === "result" &&
            (msg as { output?: unknown }).output === "late output that must be ignored",
        ),
        false,
      );
      assert.deepEqual(saveThreadIdCalls, []);
      assert.deepEqual(
        historyStore.get("history-1").map((entry) => entry.role),
        ["user"],
      );
      assert.equal(clientMessages.length, 0);
    } finally {
      try {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
