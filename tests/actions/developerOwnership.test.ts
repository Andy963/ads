import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { LaneDispatchBus } from "../../server/actions/bus.js";
import { checkThreePointGate } from "../../server/actions/threePointGate.js";
import type { SessionManager } from "../../server/sessions/sessionManager.js";
import type { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import type { AgentSendOptions } from "../../server/agents/types.js";
import {
  createActionJob,
  updateActionJobStatus,
  type ActionJobStatus,
} from "../../server/state/actionJobStore.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { createPromptQueueStore } from "../../server/state/promptQueueStore.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { buildWsConnectionIdentity } from "../../server/web/server/ws/connectionIdentity.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { ToolLoopPausedError } from "../../server/runtime/toolLoopGuard.js";
import { NativeCapabilityError } from "../../server/runtime/nativeProviderCapabilities.js";
import { NativeContextLimitError } from "../../server/runtime/nativeContextProjection.js";

const OWNER = "owner-582";
const TEST_COMMAND = "node -e 'process.exit(0)'";

function git(repoPath: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFile(repoPath: string, name: string, content: string): void {
  fs.writeFileSync(path.join(repoPath, name), content);
  git(repoPath, "add", name);
  git(repoPath, "commit", "-m", `add ${name}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}

function countAcopilotPrompts(dbPath: string): number {
  const db = getStateDatabase(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS count FROM prompt_queue WHERE lane_namespace = 'web-acopilot'").get() as { count: number };
  return row.count;
}

function createOrchestrator(invoke: (input: string, options: AgentSendOptions) => Promise<{ response: string; usage: null; agentId: string }>) {
  let resetCount = 0;
  let lastResetOptions: { clearPersistedState?: boolean } | undefined;
  let threadId: string | null = null;
  const orchestrator = {
    reset(options?: { clearPersistedState?: boolean }) {
      resetCount += 1;
      lastResetOptions = options;
      threadId = `thread-${resetCount}`;
    },
    getThreadId() {
      return threadId;
    },
    setDeveloperInstructions() {},
    onEvent() {
      return () => {};
    },
    getActiveAgentId() {
      return "codex";
    },
    invokeAgent: async (_agentId: string, input: unknown, options: AgentSendOptions) =>
      await invoke(String(input), options),
  } as unknown as HybridOrchestrator;
  return {
    orchestrator,
    get resetCount() { return resetCount; },
    get lastResetOptions() { return lastResetOptions; },
    get threadId() { return threadId; },
  };
}

function createSessionManager(orchestrator: HybridOrchestrator): SessionManager {
  return {
    getOrCreate: () => orchestrator,
    getRuntimeBackend: () => "codex-app-server",
  } as unknown as SessionManager;
}

describe("Developer ownership of Actions jobs", { concurrency: false }, () => {
  let tmpDir: string;
  let repoDir: string;
  let dbPath: string;
  let projectId: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-developer-ownership-"));
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "dev");
    git(repoDir, "config", "user.email", "ownership@ads.test");
    git(repoDir, "config", "user.name", "Ownership Test");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");

    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
    resetStateDatabaseForTests();
    const db = getStateDatabase(dbPath);
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    projectId = deriveProjectSessionId(repoDir);
    const now = Date.now();
    db.prepare("INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, 'fixture', ?, ?)")
      .run(OWNER, OWNER, now, now);
    db.prepare("INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'Ownership', 'main', 0, ?, ?)")
      .run(OWNER, projectId, repoDir, now, now);
    db.prepare("UPDATE role_profiles SET model_id = 'fixture', is_enabled = 1 WHERE role = 'reviewer'").run();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps one Developer session when an incomplete turn continues", async () => {
    let developerCalls = 0;
    const resetCounts: number[] = [];
    const threadIds: Array<string | null> = [];
    const prompts: string[] = [];
    const fake = createOrchestrator(async (input, options) => {
      developerCalls += 1;
      resetCounts.push(fake.resetCount);
      threadIds.push(fake.threadId);
      prompts.push(input);
      if (developerCalls === 1) {
        return { response: "Implementation stopped before delivery.", usage: null, agentId: "codex" };
      }

      git(repoDir, "checkout", "-b", "codex/issue-582");
      commitFile(repoDir, "implementation.txt", "continued implementation\n");
      const review = await options.actionTools!.review_action();
      const delivered = await options.actionTools!.deliver_action();
      assert.equal(review.ok, true, JSON.stringify(review));
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      return { response: "Continued in the same session and delivered.", usage: null, agentId: "codex" };
    });

    const lock = new AsyncLock();
    const bus = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fake.orchestrator),
      getWorkspaceLock: () => lock,
      runtimePreflight: () => ({ ok: true, backend: "codex-app-server", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "confirmed", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 582,
      issueTitle: "Developer ownership",
      issueDescription: "Keep one session",
      acceptanceCriteria: ["Continuation keeps the session"],
    });

    await waitFor(() => {
      const current = bus.getJob(job.jobId);
      if (current?.status === "blocked" || current?.status === "failed") assert.fail(JSON.stringify(current));
      return current?.status === "completed";
    });
    assert.equal(developerCalls, 2);
    assert.deepEqual(resetCounts, [1, 1]);
    assert.deepEqual(threadIds, ["thread-1", "thread-1"]);
    assert.match(prompts[1]!, /Previous attempt failures:/);
    assert.match(prompts[1]!, /Implementation stopped before delivery/);
    assert.equal(fake.resetCount, 1);
    assert.equal(bus.getJobs(projectId, repoDir, OWNER).length, 1);
    assert.equal(lock.isBusy(), false);
    assert.equal(countAcopilotPrompts(dbPath), 0);
  });

  it("returns Reviewer defects to the same Developer turn without a new job", async () => {
    let reviewerCalls = 0;
    let developerCalls = 0;
    const threadIds: Array<string | null> = [];
    const results: Array<Record<string, unknown>> = [];
    const fake = createOrchestrator(async (_input, options) => {
      developerCalls += 1;
      git(repoDir, "checkout", "-b", "codex/issue-582");
      commitFile(repoDir, "implementation.txt", "reviewed implementation\n");

      const rejected = await options.actionTools!.review_action();
      results.push(rejected);
      threadIds.push(fake.threadId);

      const approved = await options.actionTools!.review_action();
      results.push(approved);
      const delivered = await options.actionTools!.deliver_action();
      results.push(delivered);
      return { response: "Addressed defects and delivered.", usage: null, agentId: "codex" };
    });

    const bus = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fake.orchestrator),
      runtimePreflight: () => ({ ok: true, backend: "codex-app-server", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => {
        reviewerCalls += 1;
        return reviewerCalls === 1
          ? JSON.stringify({ status: "REJECT", summary: "Needs work", defects: [{ file: "implementation.txt", line: 1, severity: "blocker", description: "Fix the marker" }] })
          : JSON.stringify({ status: "PASS", summary: "Defect addressed", defects: [] });
      },
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 582,
      issueTitle: "Developer ownership",
      issueDescription: "Return defects to Developer",
      acceptanceCriteria: ["Reviewer defects return to Developer"],
    });

    await waitFor(() => {
      const current = bus.getJob(job.jobId);
      if (current?.status === "blocked" || current?.status === "failed") assert.fail(JSON.stringify(current));
      return current?.status === "completed";
    });
    assert.equal(developerCalls, 1);
    assert.equal(reviewerCalls, 2);
    assert.deepEqual(threadIds, ["thread-1"]);
    assert.equal(results[0]?.ok, false);
    const rejectedVerdict = results[0]?.verdict as { status?: string; defects?: unknown };
    assert.ok(rejectedVerdict, JSON.stringify(results[0]));
    assert.equal(rejectedVerdict.status, "REJECT");
    assert.deepEqual(rejectedVerdict.defects, [{ file: "implementation.txt", line: 1, severity: "blocker", description: "Fix the marker" }]);
    assert.equal(results[1]?.ok, true);
    assert.equal(results[2]?.ok, true);
    assert.equal(fake.resetCount, 1);
    assert.equal(bus.getJobs(projectId, repoDir, OWNER).length, 1);
    assert.equal(countAcopilotPrompts(dbPath), 0);
  });

  it("starts the next queued job after a blocked job without an Acopilot turn", async () => {
    const db = getStateDatabase(dbPath);
    createPromptQueueStore(db).enqueue({
      authUserId: OWNER,
      userId: 1,
      sessionId: projectId,
      chatSessionId: "acopilot",
      historyKey: `${OWNER}::${projectId}::acopilot`,
      logicalHistoryKey: `${OWNER}::${projectId}::acopilot`,
      laneNamespace: "web-acopilot",
      laneGeneration: 1,
      workspaceRoot: repoDir,
      clientMessageId: "busy-acopilot",
      payload: { text: "Acopilot is busy" },
    });

    const calls: number[] = [];
    const bus = new LaneDispatchBus(db, {
      developerRunner: async (job) => {
        calls.push(Number(job.issue_id));
        if (job.issue_id === 7001) {
          git(repoDir, "checkout", "dev");
          return { exitCode: 1, error: "simulated implementation failure" };
        }
        commitFile(repoDir, "next-job.txt", "next implementation\n");
        return { exitCode: 0 };
      },
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "confirmed", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => {
        git(repoDir, "checkout", "dev");
        return { success: true };
      },
    });

    const blocked = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 7001,
      issueTitle: "Blocked job",
      issueDescription: "Always fails",
      acceptanceCriteria: ["Blocked job releases the queue"],
    });
    const next = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 7002,
      issueTitle: "Next job",
      issueDescription: "Runs after block",
      acceptanceCriteria: ["Next job starts"],
    });

    await waitFor(() => bus.getJob(next.jobId)?.status === "completed");
    assert.equal(bus.getJob(blocked.jobId)?.status, "blocked");
    assert.ok(bus.getJobs(projectId, repoDir, OWNER).some((job) => job.id === blocked.jobId && job.status === "blocked"));
    assert.deepEqual(calls, [7001, 7001, 7002]);
    assert.equal(countAcopilotPrompts(dbPath), 1, "the simulated busy Acopilot prompt must remain untouched");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM prompt_queue WHERE client_message_id LIKE 'action-takeover:%'").get() as { count: number }).count,
      0,
    );
    assert.equal(checkThreePointGate(db, repoDir, projectId).allowed, true);
  });

  it("progresses the FIFO queue when a blocked job is dismissed", async (context) => {
    const db = getStateDatabase(dbPath);
    const snapshot = { title: "Dismissed job", description: "Blocked at operator", acceptanceCriteria: ["Dismiss releases queue"], adrs: [] };
    const blocked = createActionJob(db, {
      id: "job-blocked-582",
      project_id: projectId,
      job_kind: "github_issue",
      issue_id: 7010,
      issue_title: "Dismissed job",
      issue_snapshot: snapshot,
      status: "running",
      branch: "codex/issue-7010",
      auth_user_id: OWNER,
      chat_session_id: "main",
    });
    const next = createActionJob(db, {
      id: "job-next-582",
      project_id: projectId,
      job_kind: "github_issue",
      issue_id: 7011,
      issue_title: "Queued job",
      issue_snapshot: { ...snapshot, title: "Queued job" },
      status: "queued",
      branch: "codex/issue-7011",
      auth_user_id: OWNER,
      chat_session_id: "main",
    });
    updateActionJobStatus(db, blocked.id, "blocked" as ActionJobStatus);

    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => ({ exitCode: 0 }),
      runtimePreflight: () => ({ ok: true, backend: "codex-app-server", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
    });
    const executeDeveloper = context.mock.method(bus, "executeDeveloper", async () => {});

    assert.deepEqual(bus.resolveJob(blocked.id, "dismiss", { repoPath: repoDir }), { ok: true, status: "failed" });
    await waitFor(() => bus.getJob(next.id)?.status === "running");
    await waitFor(() => executeDeveloper.mock.callCount() === 1);
    assert.equal(executeDeveloper.mock.calls[0]?.arguments[0], next.id);
  });

  it("keeps Developer history out of the detached Reviewer payload", async () => {
    const db = getStateDatabase(dbPath);
    const snapshot = {
      title: "Reviewer isolation",
      description: "Review only the contract and diff",
      acceptanceCriteria: ["Payload excludes Developer history"],
      adrs: [{ id: "ADR 0099", title: "Detached reviewer", decision: "Reviewer sees only contract, diff, and tests" }],
    };
    const job = createActionJob(db, {
      id: "job-review-582",
      project_id: projectId,
      job_kind: "github_issue",
      issue_id: 582,
      issue_title: snapshot.title,
      issue_snapshot: snapshot,
      status: "running",
      branch: "codex/issue-582",
      auth_user_id: OWNER,
      chat_session_id: "main",
    });
    git(repoDir, "checkout", "-b", "codex/issue-582");
    commitFile(repoDir, "reviewed.txt", "reviewed-marker\n");

    const identity = buildWsConnectionIdentity({
      authUserId: OWNER,
      sessionId: projectId,
      chatSessionId: "main",
      connectionId: "actions",
      generation: job.lane_generation,
    });
    const historyStore = new HistoryStore({ storagePath: db.name, namespace: "web-actions" });
    historyStore.add(identity.historyKey, {
      role: "assistant",
      text: "Developer private reasoning: internal WIP notes",
      ts: Date.now(),
    });

    let capturedPrompt = "";
    const bus = new LaneDispatchBus(db, {
      historyStore,
      testCommand: TEST_COMMAND,
      reviewerRunner: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({ status: "PASS", summary: "isolated", defects: [] });
      },
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    await bus.runJobCycle(job.id, repoDir);

    assert.match(capturedPrompt, /# GitHub Issue #582: Reviewer isolation/);
    assert.match(capturedPrompt, /Payload excludes Developer history/);
    assert.match(capturedPrompt, /ADR 0099/);
    assert.match(capturedPrompt, /Local Test Suite Execution Report/);
    assert.match(capturedPrompt, /\+reviewed-marker/);
    assert.doesNotMatch(capturedPrompt, /Developer private reasoning/);
  });

  it("clears persisted state when switching Developer session to a different job", async () => {
    let callCount = 0;
    const recordedResetOptions: Array<{ clearPersistedState?: boolean } | undefined> = [];
    const fake = createOrchestrator(async (_input, options) => {
      callCount += 1;
      recordedResetOptions.push(fake.lastResetOptions);
      if (callCount === 1) {
        return { response: "Job 1 turn 1", usage: null, agentId: "codex" };
      }
      if (callCount === 2) {
        git(repoDir, "checkout", "-b", "codex/issue-901");
        commitFile(repoDir, "file1.txt", "content1\n");
        const review = await options.actionTools!.review_action();
        const delivered = await options.actionTools!.deliver_action();
        assert.equal(review.ok, true, JSON.stringify(review));
        assert.equal(delivered.ok, true, JSON.stringify(delivered));
        return { response: "Job 1 complete", usage: null, agentId: "codex" };
      }
      git(repoDir, "checkout", "-b", "codex/issue-902");
      commitFile(repoDir, "file2.txt", "content2\n");
      const review = await options.actionTools!.review_action();
      const delivered = await options.actionTools!.deliver_action();
      assert.equal(review.ok, true, JSON.stringify(review));
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      return { response: "Job 2 complete", usage: null, agentId: "codex" };
    });

    const lock = new AsyncLock();
    const bus = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fake.orchestrator),
      getWorkspaceLock: () => lock,
      runtimePreflight: () => ({ ok: true, backend: "native", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "ok", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const job1 = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 901,
      issueTitle: "Job 1",
      issueDescription: "First job",
      acceptanceCriteria: ["AC1"],
    });

    await waitFor(() => {
      const current = bus.getJob(job1.jobId);
      if (current?.status === "blocked" || current?.status === "failed") {
        assert.fail(`Job 1 unexpected status: ${current.status}, error: ${current.error_message}, step: ${current.current_step}`);
      }
      return current?.status === "completed";
    });
    assert.equal(callCount, 2);
    assert.deepEqual(recordedResetOptions, [{ clearPersistedState: true }, { clearPersistedState: true }]);
    assert.equal(fake.resetCount, 1);

    git(repoDir, "checkout", "dev");
    const job2 = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 902,
      issueTitle: "Job 2",
      issueDescription: "Second job",
      acceptanceCriteria: ["AC2"],
    });

    await waitFor(() => {
      const current = bus.getJob(job2.jobId);
      if (current?.status === "blocked" || current?.status === "failed") {
        assert.fail(`Job 2 unexpected status: ${current.status}, error: ${current.error_message}, step: ${current.current_step}`);
      }
      return current?.status === "completed";
    });
    assert.equal(callCount, 3);
    assert.equal(fake.resetCount, 2);
    assert.deepEqual(fake.lastResetOptions, { clearPersistedState: true });
  });

  it("reworks on recoverable native errors like ToolLoopPausedError but blocks on NativeCapabilityError", async () => {
    let callCount = 0;
    const fake = createOrchestrator(async (_input, options) => {
      callCount += 1;
      if (callCount === 1) {
        throw new ToolLoopPausedError("Loop detected");
      }
      git(repoDir, "checkout", "-b", "codex/issue-903");
      commitFile(repoDir, "loop-fixed.txt", "fixed\n");
      const review = await options.actionTools!.review_action();
      const delivered = await options.actionTools!.deliver_action();
      assert.equal(review.ok, true, JSON.stringify(review));
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      return { response: "Fixed after loop pause rework", usage: null, agentId: "codex" };
    });

    const lock = new AsyncLock();
    const bus = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fake.orchestrator),
      getWorkspaceLock: () => lock,
      runtimePreflight: () => ({ ok: true, backend: "native", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "ok", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 903,
      issueTitle: "Loop pause recovery",
      issueDescription: "Recover from loop pause",
      acceptanceCriteria: ["Recovers"],
    });

    await waitFor(() => {
      const current = bus.getJob(job.jobId);
      if (current?.status === "blocked" || current?.status === "failed") {
        assert.fail(`Job unexpected status: ${current.status}, error: ${current.error_message}, step: ${current.current_step}`);
      }
      return current?.status === "completed";
    });
    assert.equal(callCount, 2);
    const completedJob = bus.getJob(job.jobId);
    assert.equal(completedJob?.rework_count, 1);

    git(repoDir, "checkout", "dev");
    let contextLimitCalls = 0;
    const fakeContextLimit = createOrchestrator(async (_input, options) => {
      contextLimitCalls += 1;
      if (contextLimitCalls === 1) {
        throw new NativeContextLimitError("Context limit reached");
      }
      git(repoDir, "checkout", "-b", "codex/issue-905");
      commitFile(repoDir, "context-fixed.txt", "fixed\n");
      const review = await options.actionTools!.review_action();
      const delivered = await options.actionTools!.deliver_action();
      assert.equal(review.ok, true, JSON.stringify(review));
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      return { response: "Fixed after context limit rework", usage: null, agentId: "codex" };
    });
    const busContextLimit = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fakeContextLimit.orchestrator),
      getWorkspaceLock: () => lock,
      runtimePreflight: () => ({ ok: true, backend: "native", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "ok", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const contextJob = busContextLimit.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 905,
      issueTitle: "Context limit recovery",
      issueDescription: "Recover from context limit",
      acceptanceCriteria: ["Recovers"],
    });

    await waitFor(() => {
      const current = busContextLimit.getJob(contextJob.jobId);
      if (current?.status === "blocked" || current?.status === "failed") {
        assert.fail(`Job unexpected status: ${current.status}, error: ${current.error_message}, step: ${current.current_step}`);
      }
      return current?.status === "completed";
    });
    assert.equal(contextLimitCalls, 2);
    assert.equal(busContextLimit.getJob(contextJob.jobId)?.rework_count, 1);

    git(repoDir, "checkout", "dev");
    const fakeFatal = createOrchestrator(async () => {
      throw new NativeCapabilityError("toolCalls");
    });
    const busFatal = new LaneDispatchBus(getStateDatabase(dbPath), {
      sessionManager: createSessionManager(fakeFatal.orchestrator),
      getWorkspaceLock: () => lock,
      runtimePreflight: () => ({ ok: true, backend: "native", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
      testCommand: TEST_COMMAND,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "ok", defects: [] }),
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });

    const fatalJob = busFatal.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      authUserId: OWNER,
      issueId: 904,
      issueTitle: "Fatal capability failure",
      issueDescription: "Fails capability",
      acceptanceCriteria: ["Blocks immediately"],
    });

    await waitFor(() => busFatal.getJob(fatalJob.jobId)?.status === "blocked");
    const blockedJob = busFatal.getJob(fatalJob.jobId);
    assert.equal(blockedJob?.status, "blocked");
    assert.equal(blockedJob?.rework_count, 0);
  });
});
