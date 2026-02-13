# Design: Telegram single-user + model auto + hardening

## 设计概览

本次改动把“单用户”与“模型默认行为”从文案/约定层面落实到代码层面，并对两个高风险边界点做 hardening：

- model：把 “`auto` / 未设置 override” 统一解释为 “不传 `--model`，由 `codex` CLI config 决定”，并在 orchestrator 层显式清除历史 model。
- delegation：用行级状态机解析 `<<<agent.*` 块，避免正则跨行误匹配与重复块替换错误。
- crash：用一次性 handler + 统一的 graceful shutdown（带超时）实现可观测且更可靠的退出路径。

## 关键设计点

### D1: Telegram 单用户配置

- 新增 `TELEGRAM_ALLOWED_USER_ID`：
  - 作为首选配置入口（语义明确，减少歧义）。
- `TELEGRAM_ALLOWED_USERS` 仍可用：
  - 仅作为 legacy alias；
  - 强制只允许单值；
  - 若与 `TELEGRAM_ALLOWED_USER_ID` 同时设置，必须一致以避免隐式“选一个”的不确定行为。
- `TelegramConfig.allowedUsers` 保持数组类型：
  - 以最小改动兼容既有 `createAuthMiddleware(allowedUsers)`；
  - 在 `validateConfig` 中强制数组长度为 1，确保运行时语义一致。

### D2: 模型默认行为与 override

统一一个概念：`modelOverride?: string`

- 当任务 `model` 为显式值（非 `auto`）：
  - `modelOverride = desiredModel`
  - `orchestrator.setModel(modelOverride)`
- 当任务 `model=auto`：
  - `modelOverride = normalize(envOverride)`（例如 `TASK_QUEUE_DEFAULT_MODEL`）
  - 若 `modelOverride` 为 `undefined`：
    - `orchestrator.setModel(undefined)`，确保清除旧值；
  - 否则设置为 override。

备注：

- `selectAgentForTask` 仍需要 `modelToUse` 字符串用于推断 agent；
  - 当 `modelOverride` 为空时使用哨兵值 `default`，确保落到 `codex`；
  - 该哨兵值仅用于选择逻辑与显示，不应被传给 CLI。

### D3: Telegram crash handling

- 用 `process.once` 注册 `unhandledRejection` / `uncaughtException`，避免重复执行。
- 抽象 `gracefulShutdownAndExit({ reason, error })`：
  - 记录日志（包含原因与错误对象）；
  - best-effort 关闭资源（workspace/state DB 等）；
  - 使用短超时兜底，避免关闭流程挂死；
  - 最终 `process.exit(1)`。

### D4: delegation 解析状态机

行级扫描状态机：

- `outside`：
  - 匹配 `^<<<agent\\.([a-z0-9_-]+)\\s*$` 才进入 `inside`
- `inside`：
  - 匹配 `^>>>\\s*$` 结束并产出一个 directive
  - 否则持续收集正文
- EOF：
  - 若未遇到结束符，则丢弃该未闭合 directive

输出 directive 结构包含 `start`/`end` 区间，后续替换严格按区间进行。替换应用采用“两阶段”：

1. 按出现顺序执行 agent 调用并收集 replacement；
2. 按 `end` 从大到小应用字符串替换，避免 index 偏移。

## 风险与回滚

- 风险：`auto` 语义变化可能影响依赖旧默认模型字符串的测试与行为。
  - 缓解：更新对应测试，明确区分 “显式 model” 与 “auto/未指定”。
- 回滚：若需要回滚，优先回滚单次提交（保持改动集中、可审阅）。

