import type http from "node:http";

import type { Logger } from "../../../utils/logger.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";

export type ApiRouteContext = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  auth: { userId: string; username: string };
};

export type ApiSharedDeps = {
  logger: Logger;
  allowedDirs: string[];
  workspaceRoot: string;
  taskQueueAvailable: boolean;
  resolveTaskContext: (url: URL) => TaskQueueContext;
  promoteQueuedTasksToPending: (ctx: TaskQueueContext) => void;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  buildAttachmentRawUrl: (url: URL, attachmentId: string) => string;
};
