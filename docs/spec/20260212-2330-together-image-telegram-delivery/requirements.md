# Requirements

## 背景

`together-image` skill 当前默认把图片以 base64 打到 stdout，或写到本地文件。对 Telegram 入口而言，这两者都不符合用户预期：用户希望在 TG 里发起“画图/生成图片”请求后，机器人直接把图片作为 `photo/document` 发回当前聊天。

## 目标

1. `together-image` 在 Telegram 场景下支持把生成图片发回“发起请求的 chat”。
2. 支持显式指定 `chat_id`（例如多用户 bot）与自动注入（由 Telegram adapter 注入）。
3. 保持 CLI 的 base64 输出能力（用于 Web/调试），但在 TG 场景下建议使用 `--tg --stdout none`。

## 非目标

- 不新增 Telegram 端专用命令语法（如 `/img`），仅增强现有 skill 能力与注入链路。
- 不改变 Together 的模型选择与生成参数默认值。

## 验收标准

- `together-image.cjs --tg` 能通过以下任一方式解析 `chat_id`：
  - `--tg-chat-id <id>`
  - `ADS_TELEGRAM_CHAT_ID=<id>`
  - `TELEGRAM_ALLOWED_USER_ID=<id>`（legacy: `TELEGRAM_ALLOWED_USERS=<single id>`）
- Telegram adapter 在每次 `session.send()` 时注入 `ADS_TELEGRAM_CHAT_ID`（以及可选的 `ADS_TELEGRAM_USER_ID`），确保 skill 在 TG 请求内无需硬编码用户 id。

## 验证

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
