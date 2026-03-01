import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { detectImageInfo } from "../../../../attachments/images.js";
import type { ImageAttachmentResponse } from "../../../../attachments/types.js";
import { resolveWorkspaceStatePath } from "../../../../workspace/adsPaths.js";
import { extractMultipartFile } from "../../../multipart.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readRawBody, sendJson } from "../../http.js";

export async function handleAttachmentRoutes(
  ctx: ApiRouteContext,
  deps: Pick<ApiSharedDeps, "resolveTaskContext" | "buildAttachmentRawUrl">,
): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "POST" && pathname === "/api/attachments/images") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    const contentTypeHeader = String(req.headers["content-type"] ?? "").trim();
    let raw: Buffer;
    try {
      raw = await readRawBody(req, { maxBytes: 6 * 1024 * 1024 });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = rawMessage === "Request body too large" ? "Image too large" : rawMessage;
      sendJson(res, 413, { error: message });
      return true;
    }

    let filePart;
    try {
      filePart = extractMultipartFile(raw, contentTypeHeader, "file");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    if (!filePart) {
      sendJson(res, 400, { error: "Missing multipart field: file" });
      return true;
    }
    const bytes = filePart.data;
    if (!bytes || bytes.length === 0) {
      sendJson(res, 400, { error: "Empty file" });
      return true;
    }
    if (bytes.length > 5 * 1024 * 1024) {
      sendJson(res, 413, { error: "Image too large (>5MB)" });
      return true;
    }

    const info = detectImageInfo(bytes);
    if (!info) {
      sendJson(res, 415, { error: "Unsupported image type" });
      return true;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(info.contentType)) {
      sendJson(res, 415, { error: "Unsupported image content-type" });
      return true;
    }

    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const storageKey = `attachments/${sha256.slice(0, 2)}/${sha256}.${info.ext}`;
    const absPath = resolveWorkspaceStatePath(taskCtx.workspaceRoot, storageKey);

    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      if (!fs.existsSync(absPath)) {
        fs.writeFileSync(absPath, bytes);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: `Failed to store image: ${message}` });
      return true;
    }

    let attachment;
    try {
      attachment = taskCtx.attachmentStore.createOrGetImageAttachment({
        filename: filePart.filename,
        contentType: info.contentType,
        sizeBytes: bytes.length,
        width: info.width,
        height: info.height,
        sha256,
        storageKey,
        now: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
      return true;
    }

    const payload: ImageAttachmentResponse = {
      id: attachment.id,
      url: deps.buildAttachmentRawUrl(url, attachment.id),
      sha256: attachment.sha256,
      width: attachment.width,
      height: attachment.height,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    };
    sendJson(res, 201, payload);
    return true;
  }

  const attachmentRawMatch = /^\/api\/attachments\/([^/]+)\/raw$/.exec(pathname);
  if (attachmentRawMatch && req.method === "GET") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    let id = "";
    try {
      id = decodeURIComponent(attachmentRawMatch[1] ?? "").trim();
    } catch {
      sendJson(res, 400, { error: "Invalid attachment id" });
      return true;
    }
    const attachment = taskCtx.attachmentStore.getAttachment(id);
    if (!attachment) {
      sendJson(res, 404, { error: "Attachment not found" });
      return true;
    }
    if (attachment.kind !== "image") {
      sendJson(res, 415, { error: "Unsupported attachment kind" });
      return true;
    }
    const absPath = resolveWorkspaceStatePath(taskCtx.workspaceRoot, attachment.storageKey);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: "Attachment not found" });
        return true;
      }
    } catch {
      sendJson(res, 404, { error: "Attachment not found" });
      return true;
    }

    const etag = `"sha256-${attachment.sha256}"`;
    const ifNoneMatch = String(req.headers["if-none-match"] ?? "").trim();
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, {
        ETag: etag,
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      res.end();
      return true;
    }

    res.writeHead(200, {
      "Content-Type": attachment.contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
    });
    fs.createReadStream(absPath).pipe(res);
    return true;
  }

  return false;
}

