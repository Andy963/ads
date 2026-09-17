import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

import { HybridOrchestrator } from "../../dist/server/agents/orchestrator.js";
import { NoopAgentAvailability } from "../../dist/server/agents/health/agentAvailability.js";
import { DirectoryManager } from "../../dist/server/sessions/directoryManager.js";
import { SessionManager } from "../../dist/server/sessions/sessionManager.js";
import { resetStateDatabaseForTests } from "../../dist/server/state/database.js";
import { AsyncLock } from "../../dist/server/utils/asyncLock.js";
import { HistoryStore } from "../../dist/server/utils/historyStore.js";
import { SyncEventStore } from "../../dist/server/web/server/sync/store.js";
import { WebLaneGenerationStore } from "../../dist/server/web/server/sync/laneGeneration.js";
import { deriveProjectSessionId } from "../../dist/server/web/server/projectSessionId.js";
import { handleSyncRoutes } from "../../dist/server/web/server/api/routes/sync.js";
import { sanitizeInput } from "../../dist/server/web/utils.js";
import { attachWebSocketServer } from "../../dist/server/web/server/ws/server.js";

const execFile = promisify(execFileCallback);

export async function startChatBrowserServer(buildRoot, { legacyWorker = false, projects = false } = {}) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ads-chat-browser-server-"));
  const projectFixtures = projects
    ? [
        { root: path.join(workspaceRoot, "project-a"), name: "Project A", chatSessionId: "browser-chat-a" },
        { root: path.join(workspaceRoot, "project-b"), name: "Project B", chatSessionId: "browser-chat-b" },
      ]
    : [];
  for (const project of projectFixtures) project.id = deriveProjectSessionId(project.root);
  await Promise.all(projectFixtures.map((project) => mkdir(project.root, { recursive: true })));
  const fixtureRoots = [workspaceRoot, ...projectFixtures.map((project) => project.root)];
  for (const fixtureRoot of fixtureRoots) {
    await writeFile(path.join(fixtureRoot, "fixture.txt"), "baseline\n");
    await execFile("git", ["init", "-q"], { cwd: fixtureRoot });
    await execFile("git", ["config", "user.email", "fixture@example.invalid"], { cwd: fixtureRoot });
    await execFile("git", ["config", "user.name", "Browser Fixture"], { cwd: fixtureRoot });
    await execFile("git", ["add", "fixture.txt"], { cwd: fixtureRoot });
    await execFile("git", ["commit", "-qm", "baseline"], { cwd: fixtureRoot });
  }
  const statePath = path.join(workspaceRoot, "state.db");
  process.env.ADS_STATE_DB_PATH = statePath;
  process.env.CODEX_HOME = path.join(workspaceRoot, "codex");
  delete process.env.CFMEM_URL;
  delete process.env.CFMEM_API_KEY;
  resetStateDatabaseForTests(statePath);
  const received = [];
  const requests = [];
  const heldReplies = new Map();
  let heldAuthentication = null;
  let originOffline = false;
  const contentTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  const server = createServer(async (request, response) => {
    if (originOffline) {
      request.socket.destroy();
      return;
    }
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (pathname === "/legacy.html") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end('<!doctype html><title>Legacy PWA</title><script>navigator.serviceWorker.register("/sw.js")</script>');
        return;
      }
      if (pathname === "/sw.js" && legacyWorker) {
        response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
        response.end('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));');
        return;
      }
      if (pathname.startsWith("/api/")) {
        requests.push({ method: request.method, pathname, afterSeq: url.searchParams.get("afterSeq") });
        if (pathname === "/api/auth/status" && heldAuthentication) {
          heldAuthentication.requests += 1;
          await heldAuthentication.ready;
        }
        if (pathname === "/api/sync/events") {
          await handleSyncRoutes({ req: request, res: response, url, pathname, auth: { userId: "browser-fixture", username: "Browser fixture" } }, {
            syncEventStore, laneGenerationStore, defaultWorkspaceRoot: workspaceRoot,
            resolveWorkspaceRoot: (target) => {
              const root = target.searchParams.get("workspace");
              if (!fixtureRoots.includes(root)) throw new Error("Invalid fixture workspace");
              return root;
            },
            workerHistoryStore, advisorHistoryStore,
          });
          return;
        }
        if (pathname === "/api/paths/validate") {
          const root = url.searchParams.get("path");
          const ok = fixtureRoots.includes(root);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok, allowed: ok, exists: ok, isDirectory: ok,
            ...(ok ? { projectSessionId: deriveProjectSessionId(root), workspaceRoot: root, resolvedPath: root } : {}),
          }));
          return;
        }
        if (pathname === "/api/projects" && projectFixtures.length > 0) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            projects: projectFixtures.map((project) => ({
              id: project.id,
              workspaceRoot: project.root,
              name: project.name,
              chatSessionId: project.chatSessionId,
            })),
            activeProjectId: projectFixtures[0].id,
          }));
          return;
        }
        const fixtures = {
          "/api/auth/status": { initialized: true },
          "/api/auth/me": { id: "browser-fixture", username: "Browser fixture" },
          "/api/models": [],
          "/api/projects": { projects: [], activeProjectId: null },
          "/api/paths/subdirs": { dirs: [], allowedDirs: [workspaceRoot] },
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(fixtures[pathname] ?? {}));
        return;
      }
      const asset = path.resolve(buildRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!asset.startsWith(`${buildRoot}${path.sep}`)) throw new Error("Invalid asset path");
      const body = await readFile(asset);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(asset)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  const clients = new Set();
  const clientMetaByWs = new Map();
  const workerHistoryStore = new HistoryStore({ storagePath: statePath, namespace: "web-worker" });
  const advisorHistoryStore = new HistoryStore({ storagePath: statePath, namespace: "web-advisor" });
  const syncEventStore = new SyncEventStore({ stateDbPath: statePath });
  const laneGenerationStore = new WebLaneGenerationStore({ stateDbPath: statePath });
  const createSession = (lane) => ({ cwd }) => {
    const eventHandlers = new Set();
    let currentCwd = cwd;
    const emit = (event) => {
      for (const handler of eventHandlers) handler(event);
    };

    return new HybridOrchestrator({
      initialWorkingDirectory: cwd,
      initialModel: "browser-model",
      adapters: [{
        id: "codex",
        metadata: { id: "codex", name: "Browser fixture", capabilities: ["text"] },
        send: async (input) => {
          const marker = String(input).match(/browser-(?:advisor|worker)-[a-z0-9-]+/g)?.at(-1) ?? "unrecognized";
          received.push({ lane, marker });
          await (heldReplies.get(marker)?.ready ?? new Promise((resolve) => setTimeout(resolve, 200)));

          if (lane === "Worker" && marker.startsWith("browser-worker-")) {
            const ts = Date.now();
            const commandId = `fixture-command-${marker}`;
            const answerId = `fixture-answer-${marker}`;
            const changedFile = path.join(currentCwd, "fixture.txt");
            await writeFile(changedFile, `updated by ${marker}\n`);
            emit({ phase: "analysis", title: "Inspecting workspace", detail: "fixture step", delta: "Inspecting workspace", liveStep: true, timestamp: ts, raw: { type: "item.started", item: { type: "reasoning", id: `fixture-step-${marker}` } } });
            emit({ phase: "command", title: "Run fixture command", detail: "npm test", timestamp: ts + 1, raw: { type: "item.started", item: { type: "command_execution", id: commandId, command: "npm test", status: "in_progress" } } });
            emit({ phase: "command", title: "Run fixture command", detail: "npm test", timestamp: ts + 2, raw: { type: "item.completed", item: { type: "command_execution", id: commandId, command: "npm test", status: "completed", exit_code: 0, aggregated_output: "passed\n" } } });
            emit({ phase: "tool", title: "Update fixture", detail: "fixture.txt", timestamp: ts + 3, raw: { type: "item.completed", item: { type: "file_change", changes: [{ kind: "update", path: "fixture.txt" }] } } });
            emit({ phase: "responding", title: "Fixture answer", detail: "Worker response", delta: `Worker answer for ${marker}`, timestamp: ts + 4, raw: { type: "item.started", item: { type: "agent_message", id: answerId } } });
            emit({ phase: "responding", title: "Fixture answer", detail: "Worker response complete", timestamp: ts + 5, raw: { type: "item.completed", item: { type: "agent_message", id: answerId } } });
          }

          return { response: `${lane} reply: ${marker}`, usage: null, agentId: "codex" };
        },
        onEvent: (handler) => {
          eventHandlers.add(handler);
          return () => eventHandlers.delete(handler);
        },
        getThreadId: () => `${lane}-browser-thread`,
        reset: () => {},
        setWorkingDirectory: (workingDirectory) => {
          if (workingDirectory) currentCwd = workingDirectory;
        },
        status: () => ({ ready: true, streaming: false }),
      }],
    });
  };
  const workerLock = new AsyncLock();
  const advisorLock = new AsyncLock();
  const sockets = attachWebSocketServer({
    server,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    config: {
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      maxClients: 10,
      pingIntervalMs: 0,
      maxMissedPongs: 0,
      traceWsDuplication: false,
    },
    auth: {
      allowedOrigins: new Set(),
      isOriginAllowed: () => true,
      authenticateRequest: () => ({ ok: true, userId: "browser-fixture" }),
    },
    agents: { agentAvailability: new NoopAgentAvailability() },
    state: {
      directoryManager: new DirectoryManager([workspaceRoot]),
      workspaceCache: new Map(),
      sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
      interruptControllers: new Map(),
      clientMetaByWs,
      clients,
      cwdStore: new Map(),
      cwdStorePath: statePath,
      persistCwdStore: () => {},
      syncEventStore,
      laneGenerationStore,
    },
    sessions: {
      workerSessionManager: new SessionManager(0, 0, "workspace-write", "browser-model", undefined, undefined, {
        createSession: createSession("Worker"),
      }),
      advisorSessionManager: new SessionManager(0, 0, "read-only", "browser-model", undefined, undefined, {
        createSession: createSession("Advisor"),
      }),
      getWorkspaceLock: () => workerLock,
      getAdvisorWorkspaceLock: () => advisorLock,
    },
    history: { workerHistoryStore, advisorHistoryStore },
    tasks: {
      ensureTaskContext: () => ({}),
      promoteQueuedTasksToPending: () => {},
      broadcastToSession: () => {},
    },
    commands: {
      runAdsCommandLine: async () => ({ ok: true, output: "" }),
      sanitizeInput: (payload) => sanitizeInput(payload) ?? "",
    },
    scheduler: {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    requests,
    projects: projectFixtures,
    holdAuthentication() {
      if (heldAuthentication) throw new Error("Authentication is already held");
      let release;
      const ready = new Promise((resolve) => { release = resolve; });
      const gate = { ready, release, requests: 0 };
      heldAuthentication = gate;
      return {
        received: () => gate.requests,
        release: () => { heldAuthentication = null; gate.release(); },
      };
    },
    disconnectClients() {
      for (const client of clients) client.terminate();
    },
    setOriginOffline(value) {
      originOffline = value;
      if (value) for (const client of clients) client.terminate();
    },
    holdReply(marker) {
      if (heldReplies.has(marker)) throw new Error(`Reply is already held: ${marker}`);
      let release;
      const ready = new Promise((resolve) => { release = resolve; });
      heldReplies.set(marker, { ready, release });
      return () => {
        heldReplies.delete(marker);
        release();
      };
    },
    useCurrentServiceWorker() {
      legacyWorker = false;
    },
    async close() {
      heldAuthentication?.release();
      for (const { release } of heldReplies.values()) release();
      heldReplies.clear();
      for (const client of clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      resetStateDatabaseForTests();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
