import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { LaneDispatchBus } from "../../server/actions/bus.js";
import { getBus, setBusInstance } from "../../server/web/server/api/routes/actions.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { createPromptQueueStore } from "../../server/state/promptQueueStore.js";
import { getActionTakeover, takeoverPromptId } from "../../server/state/actionTakeoverStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import type { AgentAdapter, AgentSendOptions } from "../../server/agents/types.js";
import { executeBuiltinTool } from "../../server/tools/builtins.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { WebLaneGenerationStore } from "../../server/web/server/sync/laneGeneration.js";

it("wakes Acopilot without a socket and completes a linked execution only after fresh Review", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-takeover-integration-"));
  const workspace = path.join(root, "repo");
  fs.mkdirSync(workspace);
  const previousEnv = { ...process.env };
  process.env.ADS_STATE_DB_PATH = path.join(root, "state.db");
  process.env.ADS_TEST_STATE_ROOT = root;
  const db = getStateDatabase(process.env.ADS_STATE_DB_PATH);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "dev");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(workspace, "README.md"), "initial\n");
  git("add", "."); git("commit", "-m", "Initial");
  ensureWebAuthTables(db); ensureWebProjectTables(db);
  const owner = "owner";
  const project = deriveProjectSessionId(workspace);
  db.prepare("INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, 'fixture', 1, 1)").run(owner, owner);
  db.prepare("INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'Fixture', 'main', 0, 1, 1)").run(owner, project, workspace);
  db.prepare("UPDATE role_profiles SET model_id = 'fixture', is_enabled = 1 WHERE role = 'reviewer'").run();
  const queue = createPromptQueueStore(db);
  const workerHistory = new HistoryStore({ storagePath: db.name, namespace: "web-actions" });
  const advisorHistory = new HistoryStore({ storagePath: db.name, namespace: "web-acopilot" });
  const generations = new WebLaneGenerationStore({ stateDbPath: db.name });
  const sync = new SyncEventStore({ stateDbPath: db.name });
  const workerLock = new AsyncLock();
  const advisorLock = new AsyncLock();
  let developerTurns = 0;
  let advisorTurns = 0;
  let reviews = 0;
  let merges = 0;
  let recoveryId = "";
  const factory = (advisor: boolean) => () => new HybridOrchestrator({
    initialWorkingDirectory: workspace,
    adapters: [{
      id: "codex", metadata: { id: "codex", name: "Fixture", capabilities: ["text"] },
      send: async (input: unknown, options: AgentSendOptions = {}) => {
        if (advisor) {
          advisorTurns++;
          assert.equal(workerLock.isBusy(), false, "Previous Developer must release ownership before takeover");
          assert.match(String(input), /Automatic Actions handoff/);
          assert.ok(options.actionRecovery);
          assert.equal(options.actionTools, undefined, "Acopilot must not receive Review or delivery authority");
          const result = executeBuiltinTool("dispatch_action_job", {
            issue_id: 567, title: "Repair", description: "Implement the missing recovery marker and verify it.",
            acceptance_criteria: ["Model replacement must not replace the original"],
          }, { workspaceRoot: workspace, authUserId: owner, actionRecovery: options.actionRecovery });
          recoveryId = result.job_id;
          assert.equal(developerTurns, 1);
          return { response: "Diagnosed the missing marker and dispatched a bounded correction.", usage: null, agentId: "codex" };
        }
        developerTurns++;
        if (developerTurns === 1) return { response: "Implementation stopped before delivery.", usage: null, agentId: "codex" };
        assert.equal(advisorLock.isBusy(), false, "Acopilot must finish before recovery execution");
        assert.match(String(input), /Implement the missing recovery marker/);
        assert.match(String(input), /Original acceptance/);
        git("checkout", "-b", "codex/issue-567");
        fs.writeFileSync(path.join(workspace, "fixed.txt"), "recovered\n");
        git("add", "."); git("commit", "-m", "Fix marker");
        assert.ok(options.actionTools);
        assert.equal((await options.actionTools.deliver_action()).ok, false);
        assert.equal(merges, 0);
        assert.equal((await options.actionTools.review_action()).ok, true);
        assert.equal((await options.actionTools.deliver_action()).ok, true);
        return { response: "Reviewed and delivered.", usage: null, agentId: "codex" };
      },
      onEvent: () => () => {}, status: () => ({ ready: true, streaming: false }),
      getThreadId: () => null, reset: () => {}, setWorkingDirectory: () => {},
    } as AgentAdapter],
  });
  const worker = new SessionManager(0, 0, "workspace-write", "fixture", undefined, undefined, { createSession: factory(false) });
  const advisor = new SessionManager(0, 0, "read-only", "fixture", undefined, undefined, { createSession: factory(true) });
  const previousBus = getBus();
  const bus = new LaneDispatchBus(db, {
    sessionManager: worker, historyStore: workerHistory, getWorkspaceLock: () => workerLock,
    captureLaneGeneration: (namespace, key) => generations.getGeneration(namespace, key),
    runtimePreflight: () => ({ ok: true, backend: "codex-app-server", missingCapabilities: [], unsupportedRuntimeCapabilities: [] }),
    testCommand: "node -e 'process.exit(0)'",
    reviewerRunner: async () => { reviews++; return JSON.stringify({ status: "PASS", summary: "Marker verified", defects: [] }); },
    hasRemoteOrigin: () => false,
    mergePipeline: () => { merges++; git("checkout", "dev"); git("merge", "--ff-only", "codex/issue-567"); return { success: true }; },
  });
  setBusInstance(bus);
  const server = http.createServer();
  const wss = attachWebSocketServer({
    server, logger: { info: () => {}, warn: () => {}, debug: () => {} },
    config: { workspaceRoot: workspace, allowedDirs: [workspace], maxClients: 10, pingIntervalMs: 0, maxMissedPongs: 0, traceWsDuplication: false, autoStartPromptQueue: false },
    auth: { allowedOrigins: new Set(), isOriginAllowed: () => true, authenticateRequest: () => ({ ok: true, userId: owner }) },
    agents: { agentAvailability: new NoopAgentAvailability() },
    state: {
      directoryManager: new DirectoryManager([workspace]), workspaceCache: new Map(),
      sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
      interruptControllers: new Map(), clientMetaByWs: new Map(), clients: new Set(),
      cwdStore: new Map(), cwdStorePath: path.join(root, "cwd.json"), persistCwdStore: () => {},
      syncEventStore: sync, laneGenerationStore: generations, promptQueueStore: queue,
      prepareTakeoverPrompt: (entry) => bus.prepareTakeoverPrompt(entry),
    },
    sessions: { workerSessionManager: worker, advisorSessionManager: advisor, getWorkspaceLock: () => workerLock, getAdvisorWorkspaceLock: () => advisorLock },
    history: { workerHistoryStore: workerHistory, advisorHistoryStore: advisorHistory },
    commands: { runAdsCommandLine: async () => ({ ok: true, output: "" }), sanitizeInput: (payload) => String(payload) },
    scheduler: {},
  });
  try {
    await wss.startPromptQueue();
    bus.startTakeovers({ enqueue: wss.enqueuePrompt, get: (id) => queue.getByClientMessageId(id), isOwner: wss.isPromptQueueOwner });
    const rootJob = bus.dispatchJob({ projectId: project, repoPath: workspace, authUserId: owner, issueId: 567,
      issueTitle: "Recovery", issueDescription: "Implement marker", acceptanceCriteria: ["Original acceptance"] });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (!recoveryId || bus.getJob(recoveryId)?.status !== "completed")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(bus.getJob(recoveryId)?.status, "completed", JSON.stringify(bus.getJobs(project)));
    assert.equal(bus.getJob(rootJob.jobId)?.status, "blocked");
    assert.equal(getActionTakeover(db, rootJob.jobId)?.successor_job_id, recoveryId);
    assert.equal(advisorTurns, 1); assert.equal(developerTurns, 2);
    assert.equal(reviews, 1); assert.equal(merges, 1);
    const prompt = queue.getByClientMessageId(takeoverPromptId(rootJob.jobId))!;
    assert.equal(prompt.status, "completed");
    const transcript = advisorHistory.get(prompt.historyKey);
    assert.equal(transcript.filter((entry) => entry.role === "user").length, 1);
    assert.ok(transcript.some((entry) => entry.role === "ai" && entry.text.includes("Diagnosed")));
    const replay = sync.readAfter({ namespace: "web-acopilot", laneKey: prompt.historyKey, afterSeq: 0 });
    assert.ok(replay.events.some((event) => event.type === "result" && String(event.payload.output).includes("Diagnosed")));
    assert.equal(sync.getLatestSeq("web-acopilot", `other::${project}::acopilot`), 0);
    assert.equal(wss.clients.size, 0, "No browser connection was used to trigger the handoff");
    assert.equal(git("branch", "--show-current"), "dev");
    const nextExecution = t.mock.method(bus, "executeDeveloper", async () => {});
    const next = bus.dispatchJob({ projectId: project, repoPath: workspace, authUserId: owner, issueId: 568,
      issueTitle: "Next issue", issueDescription: "Continue after recovery", acceptanceCriteria: ["Next issue can start"] });
    const nextDeadline = Date.now() + 5000;
    while (Date.now() < nextDeadline && nextExecution.mock.callCount() === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nextExecution.mock.callCount(), 1);
    assert.equal(nextExecution.mock.calls[0].arguments[0], next.jobId);
    assert.equal(bus.getJob(next.jobId)?.status, "running");
  } finally {
    bus.stopTakeovers(); await wss.stopPromptQueue();
    wss.close(); server.close(); worker.destroy(); advisor.destroy();
    setBusInstance(previousBus); resetStateDatabaseForTests();
    process.env = previousEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
