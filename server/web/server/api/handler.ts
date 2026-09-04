import type http from "node:http";

import { isOriginAllowedForRequest } from "../../auth/origin.js";
import { authenticateRequest } from "../auth.js";
import { isStateChangingMethod, sendJson } from "../http.js";
import type { Logger } from "../../../utils/logger.js";
import type { WebWorkspaceContext } from "../workspaceContext.js";

import type { ApiRouteContext } from "./types.js";
import { handleAuthRoutes } from "./routes/auth.js";
import { handleAudioRoutes } from "./routes/audio.js";
import { handlePathRoutes } from "./routes/paths.js";
import { handleProjectRoutes } from "./routes/projects.js";
import { handleModelRoutes } from "./routes/models.js";
import { handleAttachmentRoutes } from "./routes/attachments.js";
import { handlePreferenceRoutes } from "./routes/preferences.js";
import { handleScheduleRoutes } from "./routes/schedules.js";
import { handleFileRoutes } from "./routes/files.js";
import { handleSyncRoutes } from "./routes/sync.js";
import { handleRunRoutes } from "./routes/runs.js";

import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import type { SyncEventStore } from "../sync/store.js";
import type { WebLaneGenerationStore } from "../sync/laneGeneration.js";

export function createApiRequestHandler(deps: {
  logger: Logger;
  allowedOrigins: Set<string>;
  allowedDirs: string[];
  workspaceRoot: string;
  sessionTtlSeconds: number;
  sessionPepper: string;
  resolveWorkspaceRoot: (url: URL) => string;
  resolveWorkspaceContext: (url: URL) => WebWorkspaceContext;
  scheduleCompiler: ScheduleCompiler;
  scheduler: SchedulerRuntime;
  syncEventStore: SyncEventStore;
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  workerHistoryStore?: { get: (key: string) => Array<{ role: string; text: string; ts: number; kind?: string }> };
  plannerHistoryStore?: { get: (key: string) => Array<{ role: string; text: string; ts: number; kind?: string }> };
  laneGenerationStore?: WebLaneGenerationStore;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const buildAttachmentRawUrl = (url: URL, attachmentId: string): string => {
    const workspaceParam = url.searchParams.get("workspace");
    if (!workspaceParam) {
      return `/api/attachments/${encodeURIComponent(attachmentId)}/raw`;
    }
    const qp = `workspace=${encodeURIComponent(workspaceParam)}`;
    return `/api/attachments/${encodeURIComponent(attachmentId)}/raw?${qp}`;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const pathname = url.pathname;

    if (isStateChangingMethod(req.method) && !isOriginAllowedForRequest(req, deps.allowedOrigins)) {
      sendJson(res, 403, { error: "Forbidden" });
      return true;
    }

    if (await handleAuthRoutes({ req, res, pathname }, { sessionTtlSeconds: deps.sessionTtlSeconds, sessionPepper: deps.sessionPepper })) {
      return true;
    }

    const auth = authenticateRequest(req, { sessionTtlSeconds: deps.sessionTtlSeconds, sessionPepper: deps.sessionPepper });
    if (!auth.ok) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    if (auth.setCookie) {
      res.setHeader("Set-Cookie", auth.setCookie);
    }

    const routeCtx: ApiRouteContext = { req, res, url, pathname, auth: { userId: auth.userId, username: auth.username } };
    if (await handleAudioRoutes(routeCtx, { logger: deps.logger })) return true;
    if (await handlePathRoutes(routeCtx, { allowedDirs: deps.allowedDirs })) return true;
    if (await handleProjectRoutes(routeCtx, { allowedDirs: deps.allowedDirs })) return true;
    if (await handlePreferenceRoutes(routeCtx, { workspaceRoot: deps.workspaceRoot })) return true;
    if (await handleFileRoutes(routeCtx, { resolveWorkspaceContext: deps.resolveWorkspaceContext })) return true;
    if (
      await handleSyncRoutes(routeCtx, {
        syncEventStore: deps.syncEventStore,
        defaultWorkspaceRoot: deps.workspaceRoot,
        resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
        workerHistoryStore: deps.workerHistoryStore ?? { get: () => [] },
        plannerHistoryStore: deps.plannerHistoryStore ?? { get: () => [] },
        laneGenerationStore: deps.laneGenerationStore,
      })
    ) return true;
    if (
      await handleRunRoutes(routeCtx, {
        defaultWorkspaceRoot: deps.workspaceRoot,
        resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
        interruptControllers: deps.interruptControllers,
        promptRunEpochs: deps.promptRunEpochs,
        laneGenerationStore: deps.laneGenerationStore,
      })
    ) return true;
    if (await handleScheduleRoutes(routeCtx, { resolveWorkspaceRoot: deps.resolveWorkspaceRoot, scheduleCompiler: deps.scheduleCompiler, scheduler: deps.scheduler })) return true;
    if (await handleModelRoutes(routeCtx)) return true;
    if (await handleAttachmentRoutes(routeCtx, { resolveWorkspaceContext: deps.resolveWorkspaceContext, buildAttachmentRawUrl })) return true;

    sendJson(res, 404, { error: "Not Found" });
    return true;
  };
}
