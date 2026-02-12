export type AudioTranscriptionProvider = "together" | "openai";

export type AudioTranscriptionResult =
  | { ok: true; text: string; provider: AudioTranscriptionProvider }
  | { ok: false; error: string; errors: string[]; timedOut: boolean };

function normalizeContentType(raw: string | undefined): string {
  let contentType = String(raw ?? "").trim();
  if (contentType.includes(";")) {
    contentType = contentType.split(";")[0]!.trim();
  }
  return contentType || "application/octet-stream";
}

function resolveAudioExt(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("mp4") || t.includes("m4a")) return "m4a";
  return "bin";
}

function resolveProviderPreference(): AudioTranscriptionProvider {
  const preferProviderRaw = String(process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER ?? "together").trim().toLowerCase();
  return preferProviderRaw === "openai" ? "openai" : "together";
}

function resolveTogetherKey(): string {
  return String(process.env.TOGETHER_API_KEY ?? "").trim();
}

function resolveOpenAIKey(): string {
  return String(process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? process.env.CCHAT_OPENAI_API_KEY ?? "").trim();
}

function resolveOpenAIBaseUrl(): string {
  return String(
    process.env.OPENAI_BASE_URL ??
      process.env.OPENAI_API_BASE ??
      process.env.CODEX_BASE_URL ??
      "https://api.openai.com/v1",
  ).trim();
}

function resolveTimeoutMs(): number {
  const timeoutMsRaw = Number(process.env.ADS_TOGETHER_AUDIO_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(timeoutMsRaw) ? Math.max(1000, timeoutMsRaw) : 60_000;
}

export async function transcribeAudioBuffer(args: {
  audio: Buffer;
  contentType?: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<AudioTranscriptionResult> {
  const startedAt = Date.now();
  const audio = args.audio;
  if (!audio || audio.length === 0) {
    return { ok: false, error: "音频为空", errors: ["audio: empty"], timedOut: false };
  }

  const preferProvider = resolveProviderPreference();
  const togetherKey = resolveTogetherKey();
  const openaiKey = resolveOpenAIKey();
  const openaiBaseUrl = resolveOpenAIBaseUrl();
  const contentType = normalizeContentType(args.contentType);
  const audioBytes = audio.length;
  const ext = resolveAudioExt(contentType);
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
    return String(nestedError?.message ?? record?.message ?? record?.error ?? raw ?? "").trim() || `Upstream error (${status})`;
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
  const timeoutMs = resolveTimeoutMs();
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
            { name: "openai" as const, fn: callOpenAI },
            { name: "together" as const, fn: callTogether },
          ]
        : [
            { name: "together" as const, fn: callTogether },
            { name: "openai" as const, fn: callOpenAI },
          ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const text = (await attempt.fn()).trim();
        if (!text) {
          throw new Error("未识别到文本");
        }
        args.logger?.info?.(
          `[Audio] transcription ok provider=${attempt.name} duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType}`,
        );
        return { ok: true, text, provider: attempt.name };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.name}: ${message || "unknown error"}`);
        args.logger?.warn?.(`[Audio] transcription via ${attempt.name} failed: ${message}`);
        if (controller.signal.aborted) {
          break;
        }
      }
    }

    if (controller.signal.aborted) {
      args.logger?.warn?.(
        `[Audio] transcription timeout duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType} prefer_provider=${preferProvider}`,
      );
      return { ok: false, error: "语音识别超时", errors, timedOut: true };
    }

    args.logger?.warn?.(
      `[Audio] transcription failed duration_ms=${Date.now() - startedAt} bytes=${audioBytes} content_type=${contentType} prefer_provider=${preferProvider}`,
    );
    return { ok: false, error: errors[0] ?? "语音识别失败", errors, timedOut: false };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: aborted ? "语音识别超时" : message, errors: [message], timedOut: aborted };
  } finally {
    clearTimeout(timeout);
  }
}

