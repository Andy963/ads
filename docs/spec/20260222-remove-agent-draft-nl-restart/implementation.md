# Implementation

## Web

- `src/web/server/ws/handleCommand.ts`
  - 删除 `/agent` 分支与相关帮助文本。
  - 新增 `parsed.type === "set_agent"` 的处理分支：切换 agent 并回送 `type: "agents"` snapshot（仅回送到当前连接，不广播）。
- `web/src/app/tasks.ts`
  - 将 agent 切换从 `/agent ...` silent command 改为发送 `set_agent` 控制消息。
- `tests/web/slashCommandsDisabled.test.ts`
  - 移除/更新与 `/agent` 相关的测试，新增覆盖 `set_agent` 不会触发 `runAdsCommandLine`，并返回 `type: "agents"`。

## Telegram

- `src/telegram/bot.ts`
  - 移除 `/draft` 与 `td:*` callback 相关实现、命令注册与文案。
  - 在 `message:text` 进入模型路径前新增 restart 意图拦截，并在满足 guardrails 时执行自杀式重启。
- `src/telegram/utils/taskDrafts.ts`、`tests/telegram/taskDrafts.test.ts`
  - 若无其它引用，删除（或移除导出并清理引用）。

## Docs

- `README.md`
  - 移除 `/draft` 与 `/agent` 相关说明。
  - 补充 Telegram 自然语言重启短语、guardrails、以及（可选）`restart web/all` 的环境变量配置说明。

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```
