import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { Input } from "@openai/codex-sdk";

import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { TaskCoordinator } from "../../src/agents/tasks/taskCoordinator.js";
import { TaskStore } from "../../src/agents/tasks/taskStore.js";

import { resetStateDatabaseForTests } from "../../src/state/database.js";

class QueueAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly queue: string[];

  constructor(options: { id: string; name: string; queue: string[] }) {
    this.id = options.id;
    this.queue = [...options.queue];
    this.metadata = {
      id: options.id,
      name: options.name,
      vendor: "test",
      capabilities: ["text"],
    };
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: false, throttleMs: 0 };
  }

  status() {
    return { ready: true, streaming: false };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    void handler;
    return () => undefined;
  }

  reset(): void {
    // stateless
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    void input;
    void options;
    const response = this.queue.shift() ?? "(no response)";
    return { response, usage: null, agentId: this.id };
  }
}

describe("agents/tasks/taskCoordinator", () => {
  beforeEach(() => {
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
  });

  it("runs a task and marks it DONE after accept verdict", async () => {
    const delegate = new QueueAgentAdapter({
      id: "claude",
      name: "Claude",
      queue: [
        [
          "```json",
          JSON.stringify(
            {
              taskId: "t_accept",
              revision: 1,
              status: "submitted",
              summary: "done",
              changedFiles: [],
              howToVerify: [],
              knownRisks: [],
              questions: [],
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
      ],
    });

    const orchestrator = new HybridOrchestrator({
      adapters: [delegate],
      defaultAgentId: "claude",
      initialWorkingDirectory: process.cwd(),
    });

    const coordinator = new TaskCoordinator(orchestrator, {
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s1",
      stateDbPath: ":memory:",
      supervisorAgentId: "codex",
      supervisorName: "Codex",
      maxSupervisorRounds: 2,
      maxDelegations: 5,
      maxParallelDelegations: 2,
      taskTimeoutMs: 5_000,
      maxTaskAttempts: 1,
      retryBackoffMs: 10,
      verificationCwd: process.cwd(),
    });

    const initialSupervisorResult: AgentRunResult = {
      agentId: "codex",
      usage: null,
      response: [
        "<<<agent.claude",
        JSON.stringify(
          {
            taskId: "t_accept",
            revision: 1,
            agentId: "claude",
            goal: "do",
            constraints: [],
            deliverables: [],
            acceptanceCriteria: [],
            verification: { commands: [] },
          },
          null,
          2,
        ),
        ">>>",
      ].join("\n"),
    };

    const coordination = await coordinator.run({
      initialSupervisorResult,
      runSupervisor: async () => ({
        agentId: "codex",
        usage: null,
        response: [
          "```json",
          JSON.stringify({ verdicts: [{ taskId: "t_accept", accept: true, note: "ok" }] }, null, 2),
          "```",
        ].join("\n"),
      }),
    });

    assert.equal(coordination.rounds, 1);
    assert.equal(coordination.delegations.length, 1);

    const store = new TaskStore({
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s1",
      dbPath: ":memory:",
    });
    const task = store.getTask("t_accept");
    assert.ok(task);
    assert.equal(task.status, "DONE");
    assert.equal(task.revision, 1);
  });

  it("supports revision loop after reject verdict", async () => {
    const delegate = new QueueAgentAdapter({
      id: "gemini",
      name: "Gemini",
      queue: [
        [
          "```json",
          JSON.stringify(
            {
              taskId: "t_rework",
              revision: 1,
              status: "submitted",
              summary: "v1",
              changedFiles: [],
              howToVerify: [],
              knownRisks: [],
              questions: [],
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
        [
          "```json",
          JSON.stringify(
            {
              taskId: "t_rework",
              revision: 2,
              status: "submitted",
              summary: "v2",
              changedFiles: [],
              howToVerify: [],
              knownRisks: [],
              questions: [],
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
      ],
    });

    const orchestrator = new HybridOrchestrator({
      adapters: [delegate],
      defaultAgentId: "gemini",
      initialWorkingDirectory: process.cwd(),
    });

    const coordinator = new TaskCoordinator(orchestrator, {
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s2",
      stateDbPath: ":memory:",
      supervisorAgentId: "codex",
      supervisorName: "Codex",
      maxSupervisorRounds: 3,
      maxDelegations: 5,
      maxParallelDelegations: 1,
      taskTimeoutMs: 5_000,
      maxTaskAttempts: 1,
      retryBackoffMs: 10,
      verificationCwd: process.cwd(),
    });

    const initialSupervisorResult: AgentRunResult = {
      agentId: "codex",
      usage: null,
      response: [
        "<<<agent.gemini",
        JSON.stringify(
          {
            taskId: "t_rework",
            revision: 1,
            agentId: "gemini",
            goal: "do",
            constraints: [],
            deliverables: [],
            acceptanceCriteria: [],
            verification: { commands: [] },
          },
          null,
          2,
        ),
        ">>>",
      ].join("\n"),
    };

    let supervisorCalls = 0;
    const coordination = await coordinator.run({
      initialSupervisorResult,
      runSupervisor: async () => {
        supervisorCalls += 1;
        const accept = supervisorCalls > 1;
        return {
          agentId: "codex",
          usage: null,
          response: [
            "```json",
            JSON.stringify(
              {
                verdicts: [
                  {
                    taskId: "t_rework",
                    accept,
                    note: accept ? "ok" : "please revise",
                  },
                ],
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        };
      },
    });

    assert.equal(coordination.rounds, 2);
    assert.equal(supervisorCalls, 2);

    const store = new TaskStore({
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s2",
      dbPath: ":memory:",
    });
    const task = store.getTask("t_rework");
    assert.ok(task);
    assert.equal(task.status, "DONE");
    assert.equal(task.revision, 2);
    assert.ok(task.attempts >= 2);
  });
});

