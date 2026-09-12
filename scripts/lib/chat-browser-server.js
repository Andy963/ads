import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { attachWebSocketServer } from "../../dist/server/web/server/ws/server.js";

export async function startChatBrowserServer(buildRoot, { legacyWorker = false } = {}) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ads-chat-browser-server-"));
  const statePath = path.join(workspaceRoot, "state.db");
  process.env.ADS_STATE_DB_PATH = statePath;
  process.env.CODEX_HOME = path.join(workspaceRoot, "codex");
  delete process.env.CFMEM_URL;
  delete process.env.CFMEM_API_KEY;
  resetStateDatabaseForTests(statePath);
  const received = [];
  const requests = [];
  const heldReplies = new Map();
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
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
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
        requests.push({ method: request.method, pathname });
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
  const plannerHistoryStore = new HistoryStore({ storagePath: statePath, namespace: "web-planner" });
  const createSession = (lane) => ({ cwd }) => new HybridOrchestrator({
    initialWorkingDirectory: cwd,
    initialModel: "browser-model",
    adapters: [{
      id: "codex",
      metadata: { id: "codex", name: "Browser fixture", capabilities: ["text"] },
      send: async (input) => {
        const marker = String(input).match(/browser-(?:advisor|worker)-[a-z0-9-]+/g)?.at(-1) ?? "unrecognized";
        received.push({ lane, marker });
        await (heldReplies.get(marker)?.ready ?? new Promise((resolve) => setTimeout(resolve, 200)));
        return { response: `${lane} reply: ${marker}`, usage: null, agentId: "codex" };
      },
      onEvent: () => () => {},
      getThreadId: () => `${lane}-browser-thread`,
      reset: () => {},
      setWorkingDirectory: () => {},
      status: () => ({ ready: true, streaming: false }),
    }],
  });
  const workerLock = new AsyncLock();
  const plannerLock = new AsyncLock();
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
      syncEventStore: new SyncEventStore({ stateDbPath: statePath }),
    },
    sessions: {
      workerSessionManager: new SessionManager(0, 0, "workspace-write", "browser-model", undefined, undefined, {
        createSession: createSession("Worker"),
      }),
      plannerSessionManager: new SessionManager(0, 0, "read-only", "browser-model", undefined, undefined, {
        createSession: createSession("Advisor"),
      }),
      getWorkspaceLock: () => workerLock,
      getPlannerWorkspaceLock: () => plannerLock,
    },
    history: { workerHistoryStore, plannerHistoryStore },
    tasks: {
      ensureTaskContext: () => ({}),
      promoteQueuedTasksToPending: () => {},
      broadcastToSession: () => {},
    },
    commands: {
      runAdsCommandLine: async () => ({ ok: true, output: "" }),
      sanitizeInput: (payload) => String(payload ?? ""),
    },
    scheduler: {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    requests,
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
