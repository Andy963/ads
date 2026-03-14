import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

export type ResolvedTaskContext = ReturnType<ApiSharedDeps["resolveTaskContext"]>;

export function resolveTaskContextOrSendBadRequest(
  deps: Pick<ApiSharedDeps, "resolveTaskContext">,
  url: URL,
  res: ServerResponse,
): ResolvedTaskContext | null {
  try {
    return deps.resolveTaskContext(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
    return null;
  }
}

export type JsonBodyResult =
  | {
      ok: true;
      body: unknown;
    }
  | {
      ok: false;
    };

export async function readJsonBodyOrSendBadRequest(req: IncomingMessage, res: ServerResponse): Promise<JsonBodyResult> {
  try {
    const body = await readJsonBody(req);
    return { ok: true, body };
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return { ok: false };
  }
}

type AttachmentStoreLike = {
  listAttachmentsForTask: (taskId: string) => Array<{
    id: string;
    sha256: string;
    width: number;
    height: number;
    contentType: string;
    sizeBytes: number;
    filename: string | null;
  }>;
};

export function mapTaskAttachments(params: {
  taskId: string;
  attachmentStore: AttachmentStoreLike;
  buildAttachmentUrl: (attachmentId: string) => string;
}): Array<{
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename: string | null;
}> {
  const attachments = params.attachmentStore.listAttachmentsForTask(params.taskId);
  return attachments.map((a) => ({
    id: a.id,
    url: params.buildAttachmentUrl(a.id),
    sha256: a.sha256,
    width: a.width,
    height: a.height,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    filename: a.filename,
  }));
}

export function buildTaskAttachments(params: {
  taskId: string;
  url: URL;
  deps: Pick<ApiSharedDeps, "buildAttachmentRawUrl">;
  attachmentStore: AttachmentStoreLike;
}): Array<{
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename: string | null;
}> {
  return mapTaskAttachments({
    taskId: params.taskId,
    attachmentStore: params.attachmentStore,
    buildAttachmentUrl: (attachmentId) => params.deps.buildAttachmentRawUrl(params.url, attachmentId),
  });
}
