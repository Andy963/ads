import type http from "node:http";

import { isOriginAllowed } from "../../auth/origin.js";
import { authenticateRequest } from "../auth.js";
import { isStateChangingMethod, sendJson } from "../http.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { Logger } from "../../../utils/logger.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";

import type { ApiRouteContext, ApiSharedDeps } from "./types.js";
import { handleAuthRoutes } from "./routes/auth.js";
import { handleAudioRoutes } from "./routes/audio.js";
import { handlePathRoutes } from "./routes/paths.js";
import { handleProjectRoutes } from "./routes/projects.js";
import { handleModelRoutes } from "./routes/models.js";
import { handleTaskQueueRoutes } from "./routes/taskQueue.js";
import { handleAttachmentRoutes } from "./routes/attachments.js";
import { handleTaskRoutes } from "./routes/tasks.js";

export function createApiRequestHandler(deps: {
  logger: Logger;
  allowedOrigins: Set<string>;
  allowedDirs: string[];
  workspaceRoot: string;
  sessionTtlSeconds: number;
  sessionPepper: string;
  taskQueueAvailable: boolean;
  taskQueueLock: AsyncLock;
  resolveTaskContext: (url: URL) => TaskQueueContext;
  promoteQueuedTasksToPending: (ctx: TaskQueueContext) => void;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const buildAttachmentRawUrl = (url: URL, attachmentId: string): string => {
    const workspaceParam = url.searchParams.get("workspace");
    if (!workspaceParam) {
      return `/api/attachments/${encodeURIComponent(attachmentId)}/raw`;
    }
    const qp = `workspace=${encodeURIComponent(workspaceParam)}`;
    return `/api/attachments/${encodeURIComponent(attachmentId)}/raw?${qp}`;
  };

  const sharedDeps: ApiSharedDeps = {
    logger: deps.logger,
    allowedDirs: deps.allowedDirs,
    workspaceRoot: deps.workspaceRoot,
    taskQueueAvailable: deps.taskQueueAvailable,
    taskQueueLock: deps.taskQueueLock,
    resolveTaskContext: deps.resolveTaskContext,
    promoteQueuedTasksToPending: deps.promoteQueuedTasksToPending,
    broadcastToSession: deps.broadcastToSession,
    buildAttachmentRawUrl,
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const pathname = url.pathname;

    if (isStateChangingMethod(req.method) && !isOriginAllowed(req.headers["origin"], deps.allowedOrigins)) {
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
    if (await handleModelRoutes(routeCtx, { resolveTaskContext: deps.resolveTaskContext })) return true;
    if (
      await handleTaskQueueRoutes(routeCtx, {
        taskQueueAvailable: deps.taskQueueAvailable,
        taskQueueLock: deps.taskQueueLock,
        resolveTaskContext: deps.resolveTaskContext,
        promoteQueuedTasksToPending: deps.promoteQueuedTasksToPending,
      })
    )
      return true;
    if (await handleAttachmentRoutes(routeCtx, { resolveTaskContext: deps.resolveTaskContext, buildAttachmentRawUrl })) return true;
    if (await handleTaskRoutes(routeCtx, sharedDeps)) return true;

    sendJson(res, 404, { error: "Not Found" });
    return true;
  };
}
