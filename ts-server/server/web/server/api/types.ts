import type http from "node:http";

import type { WebWorkspaceContext } from "../workspaceContext.js";
import type { Logger } from "../../../utils/logger.js";

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
  resolveWorkspaceContext: (url: URL) => WebWorkspaceContext;
  buildAttachmentRawUrl: (url: URL, attachmentId: string) => string;
};
