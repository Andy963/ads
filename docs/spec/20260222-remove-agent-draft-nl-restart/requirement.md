# Requirements

## 背景

- Web WebSocket bridge 目前支持 slash command `/agent` 用于切换激活的 agent；但 Web 已有 UI 可选择 agent，不需要用户在聊天框手工输入命令。
- Telegram 目前支持 `/draft` 创建任务草稿并通过按钮确认入队；但后续希望完全走 spec/skills 流程，不再保留 Telegram 的手工 `/draft` 流程。
- Telegram 对话入口目前会把普通文本交给模型处理；当用户输入 “restart/重启” 等自然语言时，需要走确定性的真实重启动作，而不是让模型“声称已重启”。

## 目标

- Web：
  - 移除 Web slash command `/agent`（不再作为可用命令/分支被处理）。
  - 保持 Web UI 的 agent 切换能力（不依赖 `/agent`）。
- Telegram：
  - 移除 `/draft`：删除 handler、从 `setMyCommands` 移除、从任何控制命令 allowlist 移除，并清理因此变为 dead 的代码与测试。
  - 新增自然语言重启拦截：当用户发送 “restart/重启” 等常见短语时，bot 以确定性方式执行真实重启（自杀退出让 pm2 拉起），并在退出前给出确认回复。
  - 支持 “restart web” / “restart all” 的意图识别：仅当显式配置了 pm2 app name 时才允许执行；未配置时必须明确告知并且不做任何重启动作。
  - `/pref` 等既有命令行为保持不变。

## 非目标

- 不改变 task draft 的 Web 侧数据模型与 API（Web UI/规划器仍可继续使用 drafts）。
- 不引入新的数据库 schema / migration。
- 不新增项目级脚本文件（除非位于 `.agent/skills/<skill>/scripts/`）。

## 约束

- 不删除或覆盖任何数据库文件。
- 不执行 `git commit` / `git push`。
- 改动尽量小、可审阅、可回滚。
- 交付需包含 spec 三件套（requirement/design/implementation），并保证以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- Web 不再支持 `/agent` slash command（不会切换 agent，也不会以 `/agent` 作为受支持命令被处理）。
- Telegram 不再注册或处理 `/draft`（`setMyCommands` 中不存在，代码与测试中无残留依赖）。
- Telegram：在 pm2 环境下，发送 “restart/重启” 会先回复确认信息，再触发真实重启（进程退出，由 pm2 自动拉起）。
- Telegram：发送 “restart web” / “restart all” 但未配置 pm2 app name 时，会回复需要配置的提示，并且不会执行重启动作。

