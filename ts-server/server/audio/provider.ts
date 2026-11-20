import type { UpstreamCredentials } from "../state/upstreamCredentialStore.js";
import { normalizeVoiceBaseUrl } from "./settings.js";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class AudioError extends Error {
  constructor(message: string, readonly status = 502, readonly timedOut = false) { super(message); }
}

const extensions: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "video/mp4": "mp4",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mpga": "mpga", "audio/flac": "flac", "audio/x-flac": "flac",
};

export function validateAudio(audio: Buffer, contentType: string): { mime: string; filename: string } {
  if (!audio.length) throw new AudioError("音频为空。", 400);
  if (audio.length > MAX_AUDIO_BYTES) throw new AudioError("音频大小超过 25 MiB 限制。", 413);
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  const extension = extensions[mime];
  if (!extension) throw new AudioError("不支持该音频格式，请使用 WebM、Ogg、WAV、MP3、MP4/M4A 或 FLAC。", 415);
  return { mime, filename: `recording.${extension}` };
}

export interface TranscriptionRequest {
  audio: Buffer;
  contentType: string;
  model: string;
  language: string;
  prompt: string;
  connection: UpstreamCredentials;
  signal: AbortSignal;
}

export type TranscriptionProvider = (request: TranscriptionRequest) => Promise<string>;

export async function transcribeWithGroq(request: TranscriptionRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { mime, filename } = validateAudio(request.audio, request.contentType);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(request.audio)], { type: mime }), filename);
  form.append("model", request.model);
  form.append("response_format", "json");
  if (request.language) form.append("language", request.language);
  if (request.prompt) form.append("prompt", request.prompt);
  const response = await fetchImpl(`${normalizeVoiceBaseUrl(request.connection.baseUrl)}/audio/transcriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${request.connection.apiKey}` }, body: form,
    redirect: "error", signal: request.signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new AudioError("转写服务认证失败，请在语音转写设置中更换 API 密钥。");
    if (response.status === 429) throw new AudioError("转写服务请求过于频繁，请稍后重试。", 429);
    if (response.status === 413) throw new AudioError("转写服务拒绝了该音频大小。", 413);
    if (response.status === 400 || response.status === 415) throw new AudioError("转写服务拒绝了该音频或模型配置。", 400);
    throw new AudioError("转写服务暂时不可用，请稍后重试。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AudioError("转写服务返回了空响应。");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256 * 1024) throw new AudioError("转写服务响应超过大小限制。");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AudioError("转写服务返回的数据格式无效。"); }
  const text = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text.trim() : "";
  if (!text) throw new AudioError("转写服务未返回文本。");
  if (text.length > 64_000) throw new AudioError("转写文本超过长度限制。");
  return text;
}
