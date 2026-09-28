import type { VoiceTranscriptionResponse } from "../../shared/voice.js";
import type { completeNativeChat } from "../runtime/openAiCompatibleClient.js";
import { getStateDatabase } from "../state/database.js";
import { correctDictationText } from "./correction.js";
import { AudioError, transcribeWithGroq, validateAudio, type TranscriptionProvider } from "./provider.js";
import { createVoiceSettingsStore, type VoiceSettingsStore } from "./settings.js";

export type AudioTranscriptionResult = VoiceTranscriptionResponse | {
  ok: false; error: string; timedOut: boolean; status: number;
};

async function withDeadline<T>(parent: AbortSignal, milliseconds: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new AudioError("语音处理超时。", 504, true)), milliseconds);
  const signal = AbortSignal.any([parent, timeout.signal]);
  try {
    signal.throwIfAborted();
    const result = await run(signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally { clearTimeout(timer); }
}

export async function transcribeAudioBuffer(args: {
  audio: Buffer;
  contentType?: string;
  owner: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  signal?: AbortSignal;
  settingsStore?: VoiceSettingsStore;
  provider?: TranscriptionProvider;
  completeImpl?: typeof completeNativeChat;
}): Promise<AudioTranscriptionResult> {
  const start = performance.now();
  const signal = args.signal ?? new AbortController().signal;
  const timings = { transcriptionMs: 0, correctionMs: 0, totalMs: 0 };
  let status = "failed";
  let correctionStatus = "disabled";
  try {
    signal.throwIfAborted();
    validateAudio(args.audio, args.contentType ?? "");
    let settings;
    try { settings = (args.settingsStore ?? createVoiceSettingsStore(getStateDatabase())).resolve(args.owner); }
    catch { throw new AudioError("语音配置不可用，请在「模型配置 → 语音转写」中保存有效的服务地址和密钥。", 409); }
    const { config } = settings;
    correctionStatus = config.correction.enabled ? "not_started" : "disabled";
    const total = new AbortController();
    const totalTimer = setTimeout(() => total.abort(new AudioError("语音处理超时。", 504, true)), config.totalTimeoutMs);
    const totalSignal = AbortSignal.any([signal, total.signal]);
    try {
      let rawText: string;
      const transcriptionStart = performance.now();
      try {
        rawText = await withDeadline(totalSignal, config.transcription.timeoutMs, (stageSignal) => (args.provider ?? transcribeWithGroq)({
          audio: args.audio, contentType: args.contentType ?? "", ...config.transcription,
          connection: settings.transcription, signal: stageSignal,
        }));
      } finally { timings.transcriptionMs = Math.round(performance.now() - transcriptionStart); }
      let text = rawText;
      const correction: VoiceTranscriptionResponse["correction"] = { status: "disabled" };
      if (config.correction.enabled) {
        correctionStatus = "running";
        const correctionStart = performance.now();
        try {
          if (!settings.correction) throw new Error("Correction configuration unavailable.");
          text = await withDeadline(totalSignal, config.correction.timeoutMs, (stageSignal) => correctDictationText({
            rawText, systemPrompt: config.correction.systemPrompt, connection: settings.correction!, signal: stageSignal, completeImpl: args.completeImpl,
          }));
          correction.status = "completed";
        } catch (error) {
          signal.throwIfAborted();
          correction.status = "failed";
          correction.warning = settings.correctionWarning ?? (error instanceof AudioError && error.timedOut
            ? "纠错超时，已保留原始转写。"
            : "纠错失败，已保留原始转写。请检查文本纠错的连接和模型配置。");
        } finally {
          timings.correctionMs = Math.round(performance.now() - correctionStart);
          correctionStatus = signal.aborted ? "cancelled" : correction.status;
        }
      }
      correctionStatus = correction.status;
      status = "completed";
      timings.totalMs = Math.round(performance.now() - start);
      return { ok: true, text, provider: "groq", corrected: text !== rawText, correction, timings };
    } finally { clearTimeout(totalTimer); }
  } catch (error) {
    if (signal.aborted) { status = "cancelled"; throw signal.reason; }
    const failure = error instanceof AudioError ? error : new AudioError("转写请求失败，请检查服务连接后重试。");
    status = failure.timedOut ? "timed_out" : "failed";
    return { ok: false, error: failure.message, timedOut: failure.timedOut, status: failure.status };
  } finally {
    timings.totalMs = Math.round(performance.now() - start);
    args.logger?.info?.(`[Audio] status=${status} provider=groq bytes=${args.audio.length} transcription_ms=${timings.transcriptionMs} correction_ms=${timings.correctionMs} total_ms=${timings.totalMs} correction_status=${correctionStatus}`);
  }
}
