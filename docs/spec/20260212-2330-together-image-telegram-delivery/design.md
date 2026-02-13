# Design

## chat_id 传递策略

1) **优先显式参数**：`--tg-chat-id`  
用于未来多用户场景或手工调试。

2) **运行时注入**：`ADS_TELEGRAM_CHAT_ID`  
由 Telegram adapter 在发起一次 Codex CLI 调用时，通过 `env` 注入，保证 skill 在同一请求内可准确路由。

3) **兼容回退**：`TELEGRAM_ALLOWED_USER_ID`（legacy: `TELEGRAM_ALLOWED_USERS`，单用户）  
保持当前单用户 bot 的行为兼容。

## 组件改动

- `.agent/skills/together-image/scripts/together-image.cjs`
  - 增加 `--tg-chat-id`
  - `resolveTelegramConfigFromEnv()` 支持从 `--tg-chat-id` / `ADS_TELEGRAM_CHAT_ID` / 单用户 `TELEGRAM_ALLOWED_USER_ID`（legacy: `TELEGRAM_ALLOWED_USERS`）推导 chat_id

- `src/telegram/adapters/codex.ts`
  - `session.send(..., { env: { ADS_TELEGRAM_CHAT_ID, ADS_TELEGRAM_USER_ID } })`

## 风险与控制

- 该 env 注入只影响本次 `codex exec` 子进程环境，不修改全局 `process.env`，避免并发污染。
- 仍依赖 `TELEGRAM_BOT_TOKEN` 存在；若缺失，应返回清晰错误。
