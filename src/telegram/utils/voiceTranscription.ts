import fs from "node:fs/promises";
import type { Api } from "grammy";

import { transcribeAudioBuffer } from "../../audio/transcription.js";
import { cleanupFile, downloadTelegramFile } from "./fileHandler.js";

function resolveVoiceFilename(mimeType: string | undefined): string {
  const t = String(mimeType ?? "").trim().toLowerCase();
  if (t.includes("webm")) return "voice.webm";
  if (t.includes("ogg")) return "voice.ogg";
  if (t.includes("wav")) return "voice.wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "voice.mp3";
  if (t.includes("mp4") || t.includes("m4a")) return "voice.m4a";
  return "voice.bin";
}

export async function transcribeTelegramVoiceMessage(args: {
  api: Api;
  fileId: string;
  mimeType?: string;
  caption?: string;
  signal?: AbortSignal;
  downloadFile?: (api: Api, fileId: string, fileName: string, signal?: AbortSignal) => Promise<string>;
  readFile?: (filePath: string) => Promise<Buffer>;
  logger?: { warn?: (msg: string) => void };
}): Promise<string> {
  const fileName = resolveVoiceFilename(args.mimeType);
  const downloadFile = args.downloadFile ?? downloadTelegramFile;
  const readFile = args.readFile ?? (async (p: string) => await fs.readFile(p));

  const filePath = await downloadFile(args.api, args.fileId, fileName, args.signal);
  try {
    const audio = await readFile(filePath);
    const result = await transcribeAudioBuffer({ audio, contentType: args.mimeType });
    if (!result.ok) {
      throw new Error(result.error || "语音识别失败");
    }
    const transcript = result.text.trim();
    if (!transcript) {
      throw new Error("未识别到文本");
    }
    const caption = String(args.caption ?? "").trim();
    return caption ? `${caption}\n\n${transcript}` : transcript;
  } finally {
    try {
      cleanupFile(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger?.warn?.(`[Telegram] Failed to cleanup voice file: ${message}`);
    }
  }
}

