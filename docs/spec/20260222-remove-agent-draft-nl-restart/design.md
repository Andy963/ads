# Design

## Web: Agent 切换（不使用 `/agent`）

- 新增一类 WS 控制消息（例如 `type: "set_agent"`）：
  - payload: `{ agentId: string }`
  - 语义：仅用于 UI 控制，不写入聊天历史，不广播到同 session 的其他 chat 面板。
- Backend 处理逻辑：
  - 在 WS command handler 中新增对 `type === "set_agent"` 的处理分支（不走 slash command 解析路径）。
  - 校验 payload 中的 `agentId` 非空。
  - 调用 `SessionManager.switchAgent(userId, agentId)` 切换当前 session 的 active agent。
  - 返回一次 `type: "agents"` snapshot（与连接时发出的结构一致），以便前端更新 `activeAgentId` 与 agent 列表状态。
- 前端改动：
  - 将当前通过 `send("command", { command: "/agent ...", silent: true })` 的切换逻辑替换为 `send("set_agent", { agentId })`。

## Telegram: 移除 `/draft`

- 删除 `/draft` command handler 与 callback query handler（`td:*`）。
- 删除 Telegram 侧 draft 相关工具模块与单测（仅当变为未引用）。
- `setMyCommands`、帮助文案、控制命令 allowlist 同步移除 `draft`。

## Telegram: 自然语言重启（pm2）

### 意图识别

- 在进入模型处理路径之前，对 `message:text` 做一次确定性识别：
  - English：`restart`, `reboot`, 以及 `restart web`, `restart all`。
  - 中文：`重启`, `重启一下`, `重启 web`, `重启 全部` 等常见写法。
- 仅对“短、明确”的文本触发（例如完全匹配/轻量归一化匹配），避免误伤普通对话。

### Guardrails

- 仅在以下条件之一满足时允许执行“自杀式重启”：
  - 运行于 pm2（检测 `process.env.pm_id` 等）；或
  - 显式 opt-in env（例如 `ADS_TG_ALLOW_SUICIDE_RESTART=true`）。

### 执行动作

- 默认（`restart/重启`）：仅重启当前 Telegram 进程：
  - 先 `ctx.reply(...)` 确认；
  - 再 `process.kill(process.pid, "SIGTERM")`（触发既有 SIGTERM 优雅退出逻辑）。
- `restart web` / `restart all`：
  - 仅当配置了 pm2 app name（例如 `ADS_PM2_APP_WEB`）才执行；
  - 未配置则回复“需要配置”并返回，不执行任何重启动作；
  - 执行时使用 detached 子进程调用 `pm2 restart <app>`，并在触发后退出当前进程（遵循 restart skill 的 “detached + sleep” 原则，避免被父进程生命周期影响）。

## 兼容性与风险

- Web 移除 `/agent` 后，任何遗留前端调用需要同步替换，否则会导致 agent 选择失效。
- Telegram 新增重启拦截属于高影响操作，必须严格限制触发条件与运行环境，避免误触导致频繁重启。
