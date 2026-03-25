import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ScheduleStore } from "../../server/scheduler/store.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";
import { processScheduleOutput } from "../../server/web/server/planner/scheduleHandler.js";

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
}

class FakeOrchestrator {
  invokeCount = 0;

  constructor(private readonly responseText: string) {}

  status(): { ready: boolean; error?: string; streaming: boolean } {
    return { ready: true, streaming: true };
  }

  setWorkingDirectory(_workingDirectory?: string): void {}

  setModel(_model?: string): void {}

  setModelReasoningEffort(_effort?: string): void {}

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

  async invokeAgent(agentId: string, _input: unknown): Promise<{ response: string; usage: null; agentId: string }> {
    this.invokeCount += 1;
    return { response: this.responseText, usage: null, agentId };
  }

  getThreadId(): string {
    return "thread-test";
  }
}

function buildScheduleSpec(): any {
  return {
    version: 1,
    name: "daily-water-reminder",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    instruction: "每天 09:00 提醒我喝水",
    delivery: {
      channels: ["web"],
      web: { audience: "owner" },
      telegram: { chatId: null },
    },
    policy: {
      workspaceWrite: false,
      network: "deny",
      maxDurationMs: 600000,
      maxRetries: 0,
      concurrencyKey: "schedule:{scheduleId}",
      idempotencyKeyTemplate: "sch:{scheduleId}:{runAtIso}",
    },
    compiledTask: {
      title: "Remind to drink water",
      prompt: "Return a reminder message.",
      expectedResultSchema: { type: "object" },
      verification: { commands: [] },
    },
    questions: [],
  };
}

function createPromptDeps(args: {
  payload: unknown;
  requestId: string;
  workspaceRoot: string;
  chatSessionId: string;
  chatMessages: unknown[];
  clientMessages: unknown[];
  historyStore: MemoryHistoryStore;
  orchestrator: FakeOrchestrator;
  scheduler?: {
    scheduleCompiler?: unknown;
    scheduler?: unknown;
  };
}) {
  return {
    request: {
      parsed: { type: "prompt" as const, payload: args.payload },
      requestId: args.requestId,
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
      authUserId: "test-user",
      sessionId: "s",
      chatSessionId: args.chatSessionId,
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
    scheduler: args.scheduler ?? {},
  };
}

describe("web/schedule output routing", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-schedule-routing-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-schedule-routing-workspace-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates schedules from worker chat output", async () => {
    const chatMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const historyStore = new MemoryHistoryStore();
    const orchestrator = new FakeOrchestrator(
      ["好的。", "```ads-schedule", "每天 09:00 提醒我喝水", "```"].join("\n"),
    );

    let registeredWorkspace: string | null = null;
    const compiler = {
      async compile(): Promise<any> {
        return buildScheduleSpec();
      },
    };

    await handlePromptMessage(
      createPromptDeps({
        payload: "请帮我每天提醒喝水",
        requestId: "req-worker-schedule-1",
        workspaceRoot,
        chatSessionId: "main",
        chatMessages,
        clientMessages,
        historyStore,
        orchestrator,
        scheduler: {
          scheduleCompiler: compiler,
          scheduler: {
            registerWorkspace(root: string) {
              registeredWorkspace = root;
            },
          },
        },
      }) as any,
    );

    const result = chatMessages.find((message) => message && typeof message === "object" && (message as { type?: unknown }).type === "result");
    assert.ok(result);
    const output = String((result as { output?: unknown }).output ?? "");
    assert.match(output, /定时任务「daily-water-reminder」已创建/);
    assert.doesNotMatch(output, /```ads-schedule/);
    assert.equal(registeredWorkspace, workspaceRoot);

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const schedules = store.listSchedules({ limit: 10 });
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!.instruction, "每天 09:00 提醒我喝水");
  });

  it("binds the current telegram chat when tg output creates a schedule", async () => {
    const compiler = {
      async compile(): Promise<any> {
        return buildScheduleSpec();
      },
    };

    let registeredWorkspace: string | null = null;
    const output = await processScheduleOutput({
      outputForChat: ["收到。", "```ads-schedule", "每天 09:00 提醒我喝水", "```"].join("\n"),
      workspaceRoot,
      scheduleCompiler: compiler as any,
      scheduler: {
        registerWorkspace(root: string) {
          registeredWorkspace = root;
        },
      } as any,
      logger: { info: () => {}, warn: () => {} },
      source: "telegram",
      telegramChatId: "786273482",
      preferTelegramDelivery: true,
    });

    assert.match(output, /定时任务「daily-water-reminder」已创建/);
    assert.doesNotMatch(output, /```ads-schedule/);
    assert.equal(registeredWorkspace, workspaceRoot);

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const schedule = store.listSchedules({ limit: 1 })[0];
    assert.ok(schedule);
    assert.ok(schedule.spec.delivery.channels.includes("telegram"));
    assert.equal(schedule.spec.delivery.telegram.chatId, "786273482");
  });
});
