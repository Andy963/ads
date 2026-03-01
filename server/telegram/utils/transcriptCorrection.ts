import { resolveGroqBaseUrl, resolveGroqKey } from "../../utils/groq.js";
import { parseBooleanFlag } from "../../utils/flags.js";

export type TranscriptCorrectionResult =
  | { ok: true; text: string; corrected: boolean }
  | { ok: false; error: string };

function resolveCorrectionEnabled(): boolean {
  return parseBooleanFlag(process.env.ADS_TELEGRAM_VOICE_CORRECTION_ENABLED, true);
}

function resolveCorrectionModel(): string {
  return (
    String(
      process.env.ADS_TELEGRAM_VOICE_CORRECTION_MODEL ??
        process.env.GROQ_TRANSCRIPT_CORRECTION_MODEL ??
        "llama-3.1-8b-instant",
    ).trim() || "llama-3.1-8b-instant"
  );
}

function resolveCorrectionTimeoutMs(): number {
  const raw = Number(process.env.ADS_TELEGRAM_VOICE_CORRECTION_TIMEOUT_MS ?? 12_000);
  return Number.isFinite(raw) ? Math.max(1000, raw) : 12_000;
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

function extractChatContent(parsed: unknown): string {
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const choices = Array.isArray(record?.choices) ? (record?.choices as unknown[]) : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : null;
  const message = first?.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : null;
  return typeof message?.content === "string" ? message.content : "";
}

function extractErrorMessage(parsed: unknown, raw: string, status: number): string {
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const nestedError = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
  return String(nestedError?.message ?? record?.message ?? record?.error ?? raw ?? "").trim() || `Upstream error (${status})`;
}

export async function correctTranscriptWithModel(args: {
  transcript: string;
  signal?: AbortSignal;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<TranscriptCorrectionResult> {
  const startedAt = Date.now();
  const input = String(args.transcript ?? "").trim();
  if (!input) {
    return { ok: true, text: "", corrected: false };
  }
  if (!resolveCorrectionEnabled()) {
    return { ok: true, text: input, corrected: false };
  }

  const groqKey = resolveGroqKey();
  if (!groqKey) {
    args.logger?.warn?.("[Telegram] GROQ_API_KEY missing; skipping transcript correction");
    return { ok: true, text: input, corrected: false };
  }
  const baseUrl = resolveGroqBaseUrl() || "https://api.groq.com/openai/v1";
  const model = resolveCorrectionModel();

  const controller = new AbortController();
  let abortedByParent = false;
  const timeoutMs = resolveCorrectionTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => {
    abortedByParent = true;
    controller.abort();
  };
  if (args.signal) {
    if (args.signal.aborted) {
      abortedByParent = true;
      controller.abort();
    } else {
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/g, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a transcription editor. Clean up the transcript by fixing obvious transcription errors and punctuation while preserving the original meaning. Do not add new information. Output only the corrected transcript, with no preamble, no quotes, and no markdown.",
          },
          { role: "user", content: input },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await upstream.text().catch(() => "");
    const parsed = parseJson(raw);
    if (!upstream.ok) {
      return { ok: false, error: extractErrorMessage(parsed, raw, upstream.status) };
    }
    const content = extractChatContent(parsed).trim();
    if (!content) {
      return { ok: false, error: "empty_correction_output" };
    }
    args.logger?.info?.(
      `[Telegram] transcript correction ok model=${model} duration_ms=${Date.now() - startedAt}`,
    );
    return { ok: true, text: content, corrected: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (abortedByParent) {
      throw error;
    }
    if (controller.signal.aborted) {
      return { ok: false, error: "transcript_correction_timeout" };
    }
    return { ok: false, error: message || "transcript_correction_failed" };
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", onAbort);
  }
}
