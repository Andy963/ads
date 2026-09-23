import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { transcribeAudioBuffer } from "../../server/audio/transcription.js";
import { correctDictationText, DICTATION_CORRECTION_SYSTEM_PROMPT } from "../../server/audio/correction.js";

function writeSkill(codexHomeDir: string, name: string): void {
  const dir = path.join(codexHomeDir, "skills", name);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    ["---", `name: ${name}`, "description: \"test\"", "---", "", "# Test", ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "scripts", "transcribe.py"), "#!/usr/bin/env python3\nprint('noop')\n", "utf8");
}

function writeRegistry(codexHomeDir: string, yamlBody: string): void {
  const dir = path.join(codexHomeDir, "skills");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.yaml"), yamlBody, "utf8");
}

describe("audio/transcription (skill-based)", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;
  let adsStateDir: string;
  let codexHomeDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-audio-transcription-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-audio-transcription-state-"));
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-audio-transcription-codex-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    process.env.CODEX_HOME = codexHomeDir;
    process.env.ADS_MIGRATE_LEGACY_SKILLS = "0";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it("picks the highest priority transcription skill", async () => {
    writeSkill(codexHomeDir, "skill-a");
    writeSkill(codexHomeDir, "skill-b");

    writeRegistry(codexHomeDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  skill-a:",
      "    provides: [audio.transcribe]",
      "    priority: 100",
      "  skill-b:",
      "    provides: [audio.transcribe]",
      "    priority: 1",
      "",
    ].join("\n"));

    const result = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("abc"),
      contentType: "audio/ogg",
      exec: async ({ args }) => {
        const scriptPath = args[0] ?? "";
        if (scriptPath.includes(`${path.sep}skill-a${path.sep}`)) {
          return {
            commandLine: "python3 transcribe.py",
            exitCode: 0,
            signal: null,
            elapsedMs: 1,
            timedOut: false,
            stdout: "hello",
            stderr: "",
            truncatedStdout: false,
            truncatedStderr: false,
          };
        }
        throw new Error(`unexpected call: ${scriptPath}`);
      },
    });

    assert.deepEqual(result, { ok: true, text: "hello", provider: "skill:skill-a" });
  });

  it("falls back to the next skill when the first one fails", async () => {
    writeSkill(codexHomeDir, "skill-a");
    writeSkill(codexHomeDir, "skill-b");

    writeRegistry(codexHomeDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  skill-a:",
      "    provides: [audio.transcribe]",
      "    priority: 100",
      "  skill-b:",
      "    provides: [audio.transcribe]",
      "    priority: 10",
      "",
    ].join("\n"));

    const result = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("abc"),
      contentType: "audio/ogg",
      exec: async ({ args }) => {
        const scriptPath = args[0] ?? "";
        if (scriptPath.includes(`${path.sep}skill-a${path.sep}`)) {
          return {
            commandLine: "python3 transcribe.py",
            exitCode: 2,
            signal: null,
            elapsedMs: 1,
            timedOut: false,
            stdout: "",
            stderr: "error: failed",
            truncatedStdout: false,
            truncatedStderr: false,
          };
        }
        if (scriptPath.includes(`${path.sep}skill-b${path.sep}`)) {
          return {
            commandLine: "python3 transcribe.py",
            exitCode: 0,
            signal: null,
            elapsedMs: 1,
            timedOut: false,
            stdout: "ok",
            stderr: "",
            truncatedStdout: false,
            truncatedStderr: false,
          };
        }
        throw new Error(`unexpected call: ${scriptPath}`);
      },
    });

    assert.deepEqual(result, { ok: true, text: "ok", provider: "skill:skill-b" });
  });

  it("passes default and configured Whisper options through the child environment", async () => {
    writeSkill(codexHomeDir, "skill-a");
    writeRegistry(codexHomeDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  skill-a:",
      "    provides: [audio.transcribe]",
      "    priority: 100",
      "",
    ].join("\n"));

    const requests: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const exec = async ({ args, env }: { args: string[]; env?: NodeJS.ProcessEnv }) => {
      requests.push({ args, env });
      return {
        commandLine: "python3 transcribe.py",
        exitCode: 0,
        signal: null,
        elapsedMs: 1,
        timedOut: false,
        stdout: "default transcript",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      };
    };

    const defaultResult = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("abc"),
      contentType: "audio/ogg",
      exec,
    });

    assert.deepEqual(defaultResult, { ok: true, text: "default transcript", provider: "skill:skill-a" });
    assert.equal(requests[0]?.args.at(-2), "--input");
    assert.equal(requests[0]?.env?.ADS_WHISPER_PROMPT, "以下是普通话的句子，包含标点符号。");
    assert.equal(requests[0]?.env?.ADS_WHISPER_LANGUAGE, "zh");

    process.env.ADS_AUDIO_TRANSCRIPTION_PROMPT = "Custom punctuation prompt.";
    process.env.ADS_AUDIO_TRANSCRIPTION_LANGUAGE = "ja";

    const configuredResult = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("def"),
      contentType: "audio/ogg",
      exec,
    });

    assert.deepEqual(configuredResult, { ok: true, text: "default transcript", provider: "skill:skill-a" });
    assert.equal(requests[1]?.env?.ADS_WHISPER_PROMPT, "Custom punctuation prompt.");
    assert.equal(requests[1]?.env?.ADS_WHISPER_LANGUAGE, "ja");
    assert.equal(process.env.ADS_WHISPER_PROMPT, originalEnv.ADS_WHISPER_PROMPT);
    assert.equal(process.env.ADS_WHISPER_LANGUAGE, originalEnv.ADS_WHISPER_LANGUAGE);
  });

  it("runs agent correction on raw transcription text and returns corrected output", async () => {
    writeSkill(codexHomeDir, "skill-a");
    writeRegistry(codexHomeDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  skill-a:",
      "    provides: [audio.transcribe]",
      "    priority: 100",
      "",
    ].join("\n"));

    const result = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("abc"),
      contentType: "audio/ogg",
      exec: async () => ({
        commandLine: "python3 transcribe.py",
        exitCode: 0,
        signal: null,
        elapsedMs: 1,
        timedOut: false,
        stdout: "帮我看一下代码里的bug",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      }),
      correctText: async (raw) => `${raw}（已由Agent校正）`,
    });

    assert.deepEqual(result, {
      ok: true,
      text: "帮我看一下代码里的bug（已由Agent校正）",
      rawText: "帮我看一下代码里的bug",
      provider: "skill:skill-a",
      corrected: true,
    });
  });

  it("gracefully falls back to raw transcription if agent correction fails", async () => {
    writeSkill(codexHomeDir, "skill-a");
    writeRegistry(codexHomeDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  skill-a:",
      "    provides: [audio.transcribe]",
      "    priority: 100",
      "",
    ].join("\n"));

    const result = await transcribeAudioBuffer({
      workspaceRoot,
      audio: Buffer.from("abc"),
      contentType: "audio/ogg",
      exec: async () => ({
        commandLine: "python3 transcribe.py",
        exitCode: 0,
        signal: null,
        elapsedMs: 1,
        timedOut: false,
        stdout: "原始听写文本",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      }),
      correctText: async () => {
        throw new Error("LLM connection timeout");
      },
    });

    assert.deepEqual(result, {
      ok: true,
      text: "原始听写文本",
      provider: "skill:skill-a",
    });
  });

  it("correctDictationText cleans quotes, code blocks, and invokes completion correctly", async () => {
    let promptCaptured: unknown;
    const corrected = await correctDictationText({
      rawText: "写一个rust的二分查找",
      env: {
        ...process.env,
        CODEX_API_KEY: "test-key",
        CODEX_BASE_URL: "https://api.example.com/v1",
        ADS_AUDIO_CORRECTION_MODEL: "test-correction-model",
      },
      completeImpl: async (req) => {
        promptCaptured = req;
        return {
          text: '```markdown\n"请帮我写一个 Rust 的二分查找实现。"\n```',
          toolCalls: [],
          usage: null,
        };
      },
    });

    assert.equal(corrected, "请帮我写一个 Rust 的二分查找实现。");
    assert.equal((promptCaptured as any)?.model, "test-correction-model");
    assert.equal((promptCaptured as any)?.messages[0]?.content, DICTATION_CORRECTION_SYSTEM_PROMPT);
    assert.equal((promptCaptured as any)?.messages[1]?.content, "写一个rust的二分查找");
  });
});
