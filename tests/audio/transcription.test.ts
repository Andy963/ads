import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { transcribeAudioBuffer } from "../../server/audio/transcription.js";

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
});
