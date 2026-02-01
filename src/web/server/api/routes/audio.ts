import type { ApiRouteContext } from "../types.js";

import { readRawBody, sendJson } from "../../http.js";

export async function handleAudioRoutes(
  ctx: ApiRouteContext,
  deps: { logger: { info?: (msg: string) => void; warn: (msg: string) => void } },
): Promise<boolean> {
  const { req, res, pathname } = ctx;
  if (req.method !== "POST" || pathname !== "/api/audio/transcriptions") {
    return false;
  }

  const startedAt = Date.now();
  const preferProviderRaw = String(process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER ?? "together").trim().toLowerCase();
  const preferProvider = preferProviderRaw === "openai" ? "openai" : "together";
  const togetherKey = String(process.env.TOGETHER_API_KEY ?? "").trim();
  const openaiKey = String(
    process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? process.env.CCHAT_OPENAI_API_KEY ?? "",
  ).trim();
  const openaiBaseUrl = String(
    process.env.OPENAI_BASE_URL ??
      process.env.OPENAI_API_BASE ??
      process.env.CODEX_BASE_URL ??
      "https://api.openai.com/v1",
  ).trim();

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

  const audioBytes = audio.length;
  const ext = (() => {
    const t = contentType.toLowerCase();
    if (t.includes("webm")) return "webm";
    if (t.includes("ogg")) return "ogg";
    if (t.includes("wav")) return "wav";
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    if (t.includes("mp4") || t.includes("m4a")) return "m4a";
    return "bin";
  })();

  const audioArrayBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;

  const createForm = (model: string): FormData => {
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([audioArrayBuffer], { type: contentType }), `recording.${ext}`);
    return form;
  };

  const parseJsonText = (raw: string): unknown => {
    try {
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  };

  const extractErrorMessage = (parsed: unknown, raw: string, status: number): string => {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const nestedError = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
    return String(nestedError?.message ?? record?.message ?? record?.error ?? raw ?? "").trim() || `上游服务错误（${status}）`;
  };

  const extractText = (parsed: unknown): string => {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    return (
      (typeof record?.text === "string" ? record.text : "") ||
      (typeof record?.transcript === "string" ? record.transcript : "") ||
      (typeof record?.transcription === "string" ? record.transcription : "")
    );
  };

  const controller = new AbortController();
  const timeoutMsRaw = Number(process.env.ADS_TOGETHER_AUDIO_TIMEOUT_MS ?? 60_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, timeoutMsRaw) : 60_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const callTogether = async (): Promise<string> => {
      if (!togetherKey) {
        throw new Error("未配置 TOGETHER_API_KEY");
      }
      const upstream = await fetch("https://api.together.xyz/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${togetherKey}` },
        body: createForm("openai/whisper-large-v3"),
        signal: controller.signal,
      });
      const raw = await upstream.text().catch(() => "");
      const parsed = parseJsonText(raw);
      if (!upstream.ok) {
        throw new Error(extractErrorMessage(parsed, raw, upstream.status));
      }
      return extractText(parsed);
    };

    const callOpenAI = async (): Promise<string> => {
      if (!openaiKey) {
        throw new Error("未配置 OPENAI_API_KEY");
      }
      const base = (openaiBaseUrl ? openaiBaseUrl : "https://api.openai.com/v1").replace(/\/+$/g, "");
      const upstream = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}` },
        body: createForm("whisper-1"),
        signal: controller.signal,
      });
      const raw = await upstream.text().catch(() => "");
      const parsed = parseJsonText(raw);
      if (!upstream.ok) {
        throw new Error(extractErrorMessage(parsed, raw, upstream.status));
      }
      return extractText(parsed);
    };

    const attempts =
      preferProvider === "openai"
        ? [
            { name: "openai", fn: callOpenAI },
            { name: "together", fn: callTogether },
          ]
        : [
            { name: "together", fn: callTogether },
            { name: "openai", fn: callOpenAI },
          ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const text = (await attempt.fn()).trim();
        if (!text) {
          throw new Error("未识别到文本");
        }
        deps.logger.info?.(
          `[Audio] transcription ok provider=${attempt.name} duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType}`,
        );
        sendJson(res, 200, { ok: true, text });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.name}: ${message || "unknown error"}`);
        deps.logger.warn(`[Audio] transcription via ${attempt.name} failed: ${message}`);
        if (controller.signal.aborted) {
          break;
        }
      }
    }

    if (controller.signal.aborted) {
      deps.logger.warn(
        `[Audio] transcription timeout duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType} prefer_provider=${preferProvider}`,
      );
      sendJson(res, 504, { error: "语音识别超时" });
      return true;
    }

    deps.logger.warn(
      `[Audio] transcription failed duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType} prefer_provider=${preferProvider}`,
    );
    sendJson(res, 502, { error: errors[0] ?? "语音识别失败" });
    return true;
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, aborted ? 504 : 502, { error: aborted ? "语音识别超时" : message });
    return true;
  } finally {
    clearTimeout(timeout);
  }
}
