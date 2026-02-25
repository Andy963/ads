import type { ApiSharedDeps } from "../../types.js";

export function parseTaskStatus(value: string | undefined | null):
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "queued":
    case "pending":
    case "planning":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return undefined;
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
  const attachments = params.attachmentStore.listAttachmentsForTask(params.taskId);
  return attachments.map((a) => ({
    id: a.id,
    url: params.deps.buildAttachmentRawUrl(params.url, a.id),
    sha256: a.sha256,
    width: a.width,
    height: a.height,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    filename: a.filename,
  }));
}
