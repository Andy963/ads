import type { ApiRouteContext } from "../types.js";

import { readRawBody, sendJson } from "../../http.js";
import { transcribeAudioBuffer } from "../../../../audio/transcription.js";

export async function handleAudioRoutes(
  ctx: ApiRouteContext,
  deps: { logger: { info?: (msg: string) => void; warn: (msg: string) => void } },
): Promise<boolean> {
  const { req, res, pathname } = ctx;
  if (req.method !== "POST" || pathname !== "/api/audio/transcriptions") {
    return false;
  }

  let contentType = String(req.headers["content-type"] ?? "").trim();
  if (contentType.includes(";")) {
    contentType = contentType.split(";")[0]!.trim();
  }
  if (!contentType) {
    contentType = "application/octet-stream";
  }

  let audio: Buffer;
  try {
    audio = await readRawBody(req, { maxBytes: 25 * 1024 * 1024 });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage === "Request body too large" ? "音频过大（>25MB）" : rawMessage;
    sendJson(res, 413, { error: message });
    return true;
  }
  if (!audio || audio.length === 0) {
    sendJson(res, 400, { error: "音频为空" });
    return true;
  }

  const result = await transcribeAudioBuffer({ audio, contentType, logger: deps.logger });
  if (result.ok) {
    sendJson(res, 200, { ok: true, text: result.text });
    return true;
  }
  sendJson(res, result.timedOut ? 504 : 502, { error: result.error });
  return true;
}
