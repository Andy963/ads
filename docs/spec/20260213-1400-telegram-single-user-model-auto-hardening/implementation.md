# Implementation: Telegram single-user + model auto + hardening

## 变更清单（按模块）

### Telegram

- `src/telegram/config.ts`
  - 新增 `TELEGRAM_ALLOWED_USER_ID` 解析与校验；
  - `TELEGRAM_ALLOWED_USERS` 降级为 legacy alias（仅允许单值）；
  - `TELEGRAM_MODEL` 作为可选 model override（空值视为未设置）。
- `src/telegram/cli.ts`
  - 更新 help 文案，提示单用户配置与 legacy 变量。
- `src/telegram/bot.ts`
  - 统一 `unhandledRejection` / `uncaughtException` 的退出逻辑；
  - best-effort 关闭资源并设置超时兜底。

### Web / Task queue / Executor

- `src/tasks/executor.ts`
  - 移除硬编码默认模型；
  - `model=auto` 时不强制指定模型，并显式清除 orchestrator 的旧 model。
- `src/web/server/taskQueue/manager.ts`
  - 取消 `TASK_QUEUE_DEFAULT_MODEL` 的硬编码回退；
  - 作为可选 override 传递给 session manager / executor。
- `src/web/server/api/routes/tasks/chat.ts`
  - `auto` 时不注入固定模型，必要时清除 model override。
- `src/web/server/startWebServer.ts`
  - 移除 web session manager 的硬编码默认模型。

### Delegation

- `src/agents/delegation.ts`
  - 用状态机替换正则解析；
  - 基于 index 区间进行替换，避免重复块误替换；
  - 补充/更新单元测试覆盖边界情况。

### Docs

- `README.md`
  - `TELEGRAM_ALLOWED_USERS` 示例改为 `TELEGRAM_ALLOWED_USER_ID`；
  - 标注 `TELEGRAM_ALLOWED_USERS` 为 legacy alias；
  - 更新关于模型配置的描述，强调 “默认由 Codex CLI config 决定”。

## 验证步骤

```bash
npx tsc --noEmit
npm run lint
npm test
```

