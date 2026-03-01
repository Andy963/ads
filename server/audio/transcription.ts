import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { detectWorkspaceFrom } from "../workspace/detector.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { discoverSkills, type SkillMetadata } from "../skills/loader.js";
import { loadSkillRegistry } from "../skills/registryMetadata.js";
import { runCommand, type CommandRunResult } from "../utils/commandRunner.js";

export type AudioTranscriptionResult =
  | { ok: true; text: string; provider: string }
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

function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ADS_AUDIO_TRANSCRIPTION_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(raw) ? Math.max(1000, raw) : 120_000;
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveTranscriptionSkillOrder(workspaceRoot: string): string[] {
  const explicit = parseCsv(process.env.ADS_AUDIO_TRANSCRIPTION_SKILLS);
  if (explicit.length > 0) {
    return explicit;
  }

  const registry = loadSkillRegistry(workspaceRoot);
  if (registry) {
    const entries: Array<{ name: string; priority: number }> = [];
    for (const [name, entry] of registry.skills.entries()) {
      if (!entry.enabled) continue;
      const provides = entry.provides.map((p) => p.trim().toLowerCase()).filter(Boolean);
      if (!provides.includes("audio.transcribe")) continue;
      entries.push({ name, priority: entry.priority });
    }
    entries.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    if (entries.length > 0) {
      return entries.map((e) => e.name);
    }
  }

  return ["groq-whisper-transcribe", "gemini-transcribe", "whisper-transcribe"];
}

function resolveTempDir(): string {
  return path.join(resolveAdsStateDir(), "temp", "audio-transcriptions");
}

function writeTempAudioFile(audio: Buffer, ext: string): string {
  const dir = resolveTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `audio-${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, audio);
  return filePath;
}

function indexSkillsByName(skills: SkillMetadata[]): Map<string, SkillMetadata> {
  const out = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!out.has(key)) {
      out.set(key, skill);
    }
  }
  return out;
}

function resolveTranscribeScript(skillLocation: string): { cmd: string; args: string[] } | null {
  const skillDir = path.dirname(skillLocation);
  const scriptsDir = path.join(skillDir, "scripts");
  const py = path.join(scriptsDir, "transcribe.py");
  if (fs.existsSync(py)) {
    return { cmd: "python3", args: [py] };
  }
  const cjs = path.join(scriptsDir, "transcribe.cjs");
  if (fs.existsSync(cjs)) {
    return { cmd: "node", args: [cjs] };
  }
  const js = path.join(scriptsDir, "transcribe.js");
  if (fs.existsSync(js)) {
    return { cmd: "node", args: [js] };
  }
  return null;
}

async function runTranscriptionSkill(args: {
  workspaceRoot: string;
  skillName: string;
  skill: SkillMetadata | null;
  audioPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  exec?: (req: {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    allowlist?: string[] | null;
  }) => Promise<CommandRunResult>;
}): Promise<{ ok: true; text: string } | { ok: false; error: string; timedOut: boolean }> {
  const skill = args.skill;
  if (!skill) {
    return { ok: false, error: `skill_not_found:${args.skillName}`, timedOut: false };
  }

  const script = resolveTranscribeScript(skill.location);
  if (!script) {
    return { ok: false, error: `skill_missing_transcribe_script:${args.skillName}`, timedOut: false };
  }

  const exec = args.exec ?? runCommand;
  const result = await exec({
    cmd: script.cmd,
    args: [...script.args, "--input", args.audioPath],
    cwd: args.workspaceRoot,
    timeoutMs: args.timeoutMs,
    env: process.env,
    signal: args.signal,
    allowlist: null,
  });

  if (result.timedOut) {
    return { ok: false, error: `timeout:${args.skillName}`, timedOut: true };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exitCode=${result.exitCode}`;
    return { ok: false, error: `failed:${args.skillName}:${detail}`, timedOut: false };
  }
  const text = result.stdout.trim();
  if (!text) {
    return { ok: false, error: `empty_output:${args.skillName}`, timedOut: false };
  }
  return { ok: true, text };
}

export async function transcribeAudioBuffer(args: {
  audio: Buffer;
  contentType?: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  workspaceRoot?: string;
  signal?: AbortSignal;
  exec?: (req: {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    allowlist?: string[] | null;
  }) => Promise<CommandRunResult>;
}): Promise<AudioTranscriptionResult> {
  const startedAt = Date.now();
  const audio = args.audio;
  if (!audio || audio.length === 0) {
    return { ok: false, error: "音频为空", errors: ["audio: empty"], timedOut: false };
  }

  const workspaceRoot = detectWorkspaceFrom(args.workspaceRoot ?? process.cwd());
  const contentType = normalizeContentType(args.contentType);
  const ext = resolveAudioExt(contentType);
  const audioPath = writeTempAudioFile(audio, ext);

  const timeoutMs = resolveTimeoutMs();
  const skills = resolveTranscriptionSkillOrder(workspaceRoot);
  const discoveredSkills = discoverSkills(workspaceRoot);
  const skillLookup = indexSkillsByName(discoveredSkills);
  const errors: string[] = [];
  let sawTimeout = false;

  try {
    for (const skillName of skills) {
      try {
        const res = await runTranscriptionSkill({
          workspaceRoot,
          skillName,
          skill: skillLookup.get(skillName.toLowerCase()) ?? null,
          audioPath,
          timeoutMs,
          signal: args.signal,
          exec: args.exec,
        });
        if (res.ok) {
          args.logger?.info?.(
            `[Audio] transcription ok provider=skill:${skillName} duration_ms=${Date.now() - startedAt} bytes=${audio.length} content_type=${contentType}`,
          );
          return { ok: true, text: res.text, provider: `skill:${skillName}` };
        }
        errors.push(res.error);
        sawTimeout = sawTimeout || res.timedOut;
        args.logger?.warn?.(`[Audio] transcription via skill:${skillName} failed: ${res.error}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${skillName}: ${message || "unknown error"}`);
        args.logger?.warn?.(`[Audio] transcription via skill:${skillName} crashed: ${message}`);
      }
    }

    if (sawTimeout) {
      return { ok: false, error: "语音识别超时", errors, timedOut: true };
    }
    return { ok: false, error: errors[0] ?? "语音识别失败", errors, timedOut: false };
  } finally {
    try {
      fs.rmSync(audioPath, { force: true });
    } catch {
      // ignore
    }
    // Best-effort cleanup of old temp files.
    try {
      const dir = resolveTempDir();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 3 * 24 * 60 * 60 * 1000) {
            fs.rmSync(full, { force: true });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
}
