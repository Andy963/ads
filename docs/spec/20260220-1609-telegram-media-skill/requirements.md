# Requirements: Telegram media skill

## 背景

- 当前 skill workflow 里需要在 Telegram 入口发送/下载媒体（图片、语音、音频、视频、文件）。
- 现有 Gemini skills 需要一个可复用的 Telegram 媒体发送能力，否则只能落到本地路径，无法在 Telegram 对话中交付。

## 目标

- 提供 workspace 级 skill：`telegram-media`
  - 发送：`photo` / `audio` / `voice` / `video` / `document` / `message`
  - 下载：通过 `file_id` 下载 Telegram 文件到本地
- 脚本应自动从 `.env`（以及可选的 `.env.local`）加载环境变量。
- Telegram 入口运行时：
  - 默认使用注入的 `ADS_TELEGRAM_CHAT_ID`
  - 默认 reply 当前触发消息（`ADS_TELEGRAM_REPLY_TO_MESSAGE_ID`）
- 更新现有 Gemini skills 文档：用 `telegram-media` 替代 `telegram.sendphoto` / `telegram.sendaudio` 等不存在的 tool。

## 非目标

- 不做音视频转码（例如 WAV -> OGG/OPUS）。
- 不引入核心 runtime 的新 tool（保持为 skill 脚本调用）。
- 不支持通过 message link/URL 拉取消息内容（Bot API 不提供通用“按 URL 取消息”能力）。

## 约束

- 安全：
  - 不得打印/记录 `TELEGRAM_BOT_TOKEN`。
- 体积限制：
  - 上传本地文件：<= 50MB（Bot API 限制）
  - 下载 Telegram 文件：<= 20MB（Bot API 限制）
- 默认下载目录：`<project_root>/.ads/temp/telegram-downloads`
  - `project_root` 由向上搜索 `.env`/`.git`/`package.json` 推断

## 验收标准

- `telegram-media`：
  - `send.py` 可在仅配置 `.env` 的情况下发送 `photo/audio/voice/video/document/message`
  - `download.py` 可通过 `file_id` 下载并打印本地路径
  - 错误输出不包含 token
- Telegram adapter：
  - 向 agent 子进程注入 `ADS_TELEGRAM_REPLY_TO_MESSAGE_ID`
- Gemini skills 文档：
  - 不再引用 `telegram.sendphoto` / `telegram.sendaudio`

## 验证方式（命令）

```bash
npx tsc --noEmit
npm run lint
npm test
```

