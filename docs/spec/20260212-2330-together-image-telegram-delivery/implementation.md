# Implementation

## 变更点

1. `.agent/skills/together-image/scripts/together-image.cjs`
   - 新增参数 `--tg-chat-id`
   - `--tg` 模式下 `chat_id` 优先级：
     1) `--tg-chat-id`
     2) `ADS_TELEGRAM_CHAT_ID`
     3) `TELEGRAM_ALLOWED_USER_ID`（legacy: `TELEGRAM_ALLOWED_USERS`，仅当是单个 id）
   - 缺失配置时提供更明确的报错信息。

2. `.agent/skills/together-image/SKILL.md`
   - 明确 TG 场景默认用法：`--tg --stdout none`
   - 说明 chat routing 规则与注入来源。

3. `src/telegram/adapters/codex.ts`
   - 在 `session.send()` 注入 `ADS_TELEGRAM_CHAT_ID` / `ADS_TELEGRAM_USER_ID`。
