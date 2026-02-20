# Requirements

## 背景

目前 ADS 的语音转录在 `src/audio/transcription.ts` 中直接集成第三方 provider（Together/OpenAI），并通过 Telegram/Web 的入口调用：

- Telegram: `src/telegram/utils/voiceTranscription.ts` -> `transcribeAudioBuffer()`
- Web: `POST /api/audio/transcriptions` -> `transcribeAudioBuffer()`

这会导致：

- provider 选择被代码写死（默认 Together），当某个 provider 已下线时仍会被优先尝试
- 无法复用/统一现有 skill 体系（可热加载、可配置优先级、可替换实现）

## 目标

- **强制走 skill** 完成音频转录，不在主代码中内置任何 Together/OpenAI/Groq/OpenRouter 的转录 HTTP 调用逻辑。
- Telegram 语音消息：通过 skill 得到转录文本后，再进入后续对话流程（把转录文本回填到消息文本中）。
- Web 端音频转录：通过 skill 得到转录文本后，`/api/audio/transcriptions` 返回 `{ ok: true, text }`，由前端回填到输入框。
- skill 优先级可配置：默认优先 `groq-whisper-transcribe`，其次 `gemini-transcribe`，最后 `whisper-transcribe`（OpenRouter）。

## 非目标

- 不要求新增/实现 Web UI 的 skill 管理界面。
- 不要求对 skill 的脚本/依赖做包管理重构（本次只负责“调用 skill 并拿到 stdout 文本”）。

## 约束

- 默认遵循 spec 三件套流程。
- 不删除或覆盖任何数据库文件（`.ads/*.db*`）。
- 修改后需要补齐/更新测试，并保证 `npx tsc --noEmit`、`npm run lint`、`npm test` 通过。

## 验收标准

- Telegram/Web 的转录都不再调用 Together/OpenAI 的内置实现。
- 当 `groq-whisper-transcribe` 失败时，会按优先级回退到下一个 skill。
- `skills metadata` 可控制同功能 skill 的优先级（`audio.transcribe` 组）。
- 测试覆盖：至少包含“按优先级选择”和“失败回退”。

