# Design

## Skill Selection

以 `audio.transcribe` 作为功能标签，在 `workspaceRoot/.agent/skills/metadata.yaml` 中配置优先级：

```yaml
version: 1
mode: overlay
skills:
  groq-whisper-transcribe:
    provides: [audio.transcribe]
    priority: 300
  gemini-transcribe:
    provides: [audio.transcribe]
    priority: 200
  whisper-transcribe:
    provides: [audio.transcribe]
    priority: 100
```

选择策略：

1. 若设置 `ADS_AUDIO_TRANSCRIPTION_SKILLS`（逗号分隔），按该顺序尝试。
2. 否则读取 registry metadata，筛选 `provides` 包含 `audio.transcribe` 的 skills，按 `priority desc` 尝试。
3. 若 registry 不存在或没有匹配项，使用内置默认顺序：
   - `groq-whisper-transcribe` -> `gemini-transcribe` -> `whisper-transcribe`

## Skill Execution Contract

仅约定一种最小契约：

- skill 目录下存在 `scripts/transcribe.py`（或 `scripts/transcribe.js` / `scripts/transcribe.cjs`）
- 接受参数：`--input <local-path>`
- 成功：`exitCode=0` 且 stdout 输出纯文本转录
- 失败：非 0 exitCode，stderr/stdout 携带错误信息

运行时将音频 buffer 写入临时文件，然后对每个候选 skill 执行一次脚本并读取 stdout。

## Entrypoints

- Telegram：`transcribeTelegramVoiceMessage()` 在下载语音后调用 `transcribeAudioBuffer()`，把转录结果回填到文本。
- Web：`POST /api/audio/transcriptions` 调用 `transcribeAudioBuffer()`，返回 JSON。

## Observability

`transcribeAudioBuffer()` 记录：

- 选择到的 skill
- 成功/失败
- 耗时和音频大小

## Failure Modes

- 没有任何候选 skill 可用：返回失败（HTTP 502 / TG 报错）。
- skill 执行超时：标记 timedOut，Web 返回 504。
- skill 输出为空：视为失败并回退到下一个。

