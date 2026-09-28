import type { ApiRouteContext } from "../types.js";
import { readJsonBody, readRawBody, sendJson } from "../../http.js";
import { transcribeAudioBuffer } from "../../../../audio/transcription.js";
import { MAX_AUDIO_BYTES } from "../../../../audio/provider.js";
import { createVoiceSettingsStore, saveVoiceSettingsSchema, saveCorrectionSettingsSchema, type VoiceSettingsStore } from "../../../../audio/settings.js";
import { getStateDatabase } from "../../../../state/database.js";

export async function handleAudioRoutes(ctx: ApiRouteContext, deps: {
  logger: { info?: (msg: string) => void; warn: (msg: string) => void };
  transcribeAudioBuffer?: typeof transcribeAudioBuffer;
  settingsStore?: VoiceSettingsStore;
}): Promise<boolean> {
  const { req, res, pathname } = ctx;
  const settingsRequest = pathname === "/api/voice/settings" && (req.method === "GET" || req.method === "PUT");
  const correctionRequest = pathname === "/api/voice/correction" && req.method === "PUT";
  const audioRequest = pathname === "/api/audio/transcriptions" && req.method === "POST";
  if (!settingsRequest && !correctionRequest && !audioRequest) return false;
  res.setHeader("Cache-Control", "no-store");
  if (!ctx.auth?.userId) { sendJson(res, 401, { error: "请先登录。" }); return true; }
  if (settingsRequest || correctionRequest) {
    try {
      const store = deps.settingsStore ?? createVoiceSettingsStore(getStateDatabase());
      if (req.method === "GET") sendJson(res, 200, store.get(ctx.auth.userId));
      else {
        const body = await readJsonBody(req);
        if (correctionRequest) sendJson(res, 200, store.saveCorrection(ctx.auth.userId, saveCorrectionSettingsSchema.parse(body)));
        else sendJson(res, 200, store.save(ctx.auth.userId, saveVoiceSettingsSchema.parse(body)));
      }
    } catch {
      sendJson(res, 400, { error: "保存失败，请检查服务地址、模型、密钥和超时设置。更换服务地址时必须填写匹配的新密钥。" });
    }
    return true;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Audio request disconnected."));
  const onClose = () => { if (!res.writableEnded) abort(); };
  req.on("aborted", abort);
  res.on("close", onClose);
  try {
    let audio: Buffer;
    try { audio = await readRawBody(req, { maxBytes: MAX_AUDIO_BYTES }); }
    catch {
      if (!controller.signal.aborted) sendJson(res, 413, { error: "无法读取音频，文件大小不能超过 25 MiB。" });
      return true;
    }
    if (req.aborted || res.destroyed) abort();
    if (controller.signal.aborted) return true;
    const result = await (deps.transcribeAudioBuffer ?? transcribeAudioBuffer)({
      audio, contentType: String(req.headers["content-type"] ?? ""), owner: ctx.auth.userId,
      logger: deps.logger, signal: controller.signal, settingsStore: deps.settingsStore,
    });
    if (!controller.signal.aborted) {
      if (result.ok) sendJson(res, 200, result);
      else sendJson(res, result.status ?? (result.timedOut ? 504 : 502), { error: result.error });
    }
  } catch {
    if (!controller.signal.aborted) sendJson(res, 502, { error: "语音请求失败，请检查语音转写配置后重试。" });
  } finally {
    req.off("aborted", abort);
    res.off("close", onClose);
  }
  return true;
}
