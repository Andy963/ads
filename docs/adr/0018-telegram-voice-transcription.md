# ADR-0018: Telegram Voice Transcription via Shared Audio Transcription Helper

- Status: Accepted
- Date: 2026-02-12

## Context

ADS Web 已提供语音识别能力（`POST /api/audio/transcriptions`），并通过环境变量选择 provider（Together/OpenAI-compatible）与模型。Telegram 入口此前只支持文本/图片/文档，用户发送语音消息时无法直接参与到同一套对话/任务工作流里。

我们希望：

- Telegram 支持 `message:voice`：先下载语音文件，再做转写，然后把转写结果当作用户输入。
- 转写 provider 选择、模型与超时策略必须与 Web 保持一致，避免两套逻辑漂移。
- 保持临时文件最小生命周期：只在转写阶段落盘，结束后清理。

## Decision

1. 抽取 Web 语音识别核心逻辑为共享 helper：`src/audio/transcription.ts`
   - provider preference：`ADS_AUDIO_TRANSCRIPTION_PROVIDER`（默认 `together`）
   - provider fallback：按 preference 顺序尝试，两家互相 fallback
   - Together model：`openai/whisper-large-v3`
   - OpenAI-compatible model：`whisper-1`
   - timeout：`ADS_TOGETHER_AUDIO_TIMEOUT_MS`（对两家尝试共用）

2. Web 路由改为调用共享 helper：`src/web/server/api/routes/audio.ts`
   - 保持原有 API contract 与状态码语义不变（`200/400/502/504`）。

3. Telegram 增加语音消息入口与转写链路：
   - 入口：`src/telegram/bot.ts` 增加 `bot.on('message:voice', ...)`
   - 适配器：`src/telegram/adapters/codex.ts` 在构建输入前调用转写，并把 `caption + transcription` 作为最终文本输入
   - 文件下载与清理：复用 `downloadTelegramFile(...)` 并在转写后执行 cleanup

## Alternatives Considered

1. **Telegram 直接调用 Web API `/api/audio/transcriptions`**
   - 优点：复用 HTTP 接口，不新增 shared helper。
   - 缺点：引入额外网络路径/鉴权与部署耦合；Telegram 与 Web server 的运行拓扑不一定一致；也会造成“内部调用外部 API”的复杂性。

2. **在 Telegram 侧复制一份转写逻辑**
   - 优点：实现快、改动面小。
   - 缺点：不可避免地漂移（provider、模型、超时、错误处理），维护成本更高。

## Consequences

- 正向：
  - Web 与 Telegram 共享同一套 provider/model 选择逻辑，降低漂移风险。
  - Telegram 语音消息可无缝进入现有 Codex 会话与工作流。
  - 临时语音文件生命周期可控（下载 → 转写 → 清理）。
- 负向/风险：
  - 语音识别依赖外部 provider，需正确配置 `TOGETHER_API_KEY` 或 `OPENAI_API_KEY` 等凭证。
  - Telegram 侧下载受 Bot API 限制（20MB）与网络环境影响，失败时只能降级为报错提示。

## References

- Spec: `docs/spec/20260212-2105-telegram-voice-transcription/requirements.md`
- Spec: `docs/spec/20260212-2105-telegram-voice-transcription/design.md`
- Spec: `docs/spec/20260212-2105-telegram-voice-transcription/implementation.md`
- Commits: `b8348ae`, `f9d416e`

