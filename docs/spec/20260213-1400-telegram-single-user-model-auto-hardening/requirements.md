# Requirements: Telegram single-user + model auto + hardening

## 背景

当前 ADS 的 Telegram bot 与任务执行链路中存在 4 类问题：

1. Telegram bot 的访问控制语义与实现不一致：产品不支持多用户，但配置/文案仍以多用户为中心。
2. 多处代码硬编码默认模型（例如某个固定的 model id），与“模型由 `codex` CLI 配置文件决定”的运行方式冲突。
3. Telegram bot 对 `unhandledRejection` / `uncaughtException` 的处理不够一致与可观测，且缺少更稳健的 best-effort 资源回收策略。
4. 协作代理指令块（`<<<agent.*` ... `>>>`）解析基于正则，容易在边界情况下误匹配/替换，且替换策略可能误替换重复块。

## 目标

### R1: Telegram 单用户配置与一致性

- 提供单用户配置入口 `TELEGRAM_ALLOWED_USER_ID`（必填）。
- `TELEGRAM_ALLOWED_USERS` 仅作为 legacy alias 支持，但必须只包含一个值；当与 `TELEGRAM_ALLOWED_USER_ID` 同时存在时必须一致，否则报错。
- 运行期语义明确：bot 只允许一个用户（通过 auth middleware 限制）。

### R2: 移除硬编码默认模型

- 在 Telegram / Web / Task executor 路径上，默认不指定模型；当用户选择 `auto` 或未配置 override 时，不应在代码里回退到某个固定模型字符串。
- 允许通过环境变量提供“显式 override”（例如 `TELEGRAM_MODEL`、`TASK_QUEUE_DEFAULT_MODEL`），但当这些变量为空/未设置时必须表现为“未指定模型”。
- 当模型未指定时，需要确保：
  - `codex` CLI adapter 不附加 `--model` 参数；
  - 现有会话/线程不会因为历史设置而继续沿用旧的显式 model（需要显式清除）。

### R3: 更稳健的 crash handling

- `uncaughtException` 与 `unhandledRejection` 至少应：
  - 记录错误原因；
  - 进行 best-effort 的资源关闭（例如 workspace/state DB）；
  - 仍然以非零退出码结束进程（保持当前“崩溃即退出”的策略）。
- 避免重复注册导致的重复执行；并提供超时兜底，避免在关闭资源时卡死。

### R4: delegation block 解析改为状态机（方案 B）

- 解析规则：
  - 指令块必须以行首 `<<<agent.<id>` 开始（允许尾部空白）。
  - 以单独一行 `>>>` 结束（允许尾部空白）。
  - 不支持嵌套；未闭合块应被忽略（不触发 agent 调用）。
- 替换策略：
  - 不能使用 `String.prototype.replace(raw, ...)` 这类“按内容替换”的做法；
  - 必须按解析得到的区间（start/end index）替换，保证重复块与同内容块不互相影响。

## 非目标

- 不引入多用户能力（包括但不限于多用户 session、不同用户的 cwd、不同用户的权限模型）。
- 不改变数据库 schema。
- 不对 Web 前端 UI 进行大改（除非为兼容显示必须）。

## 验收标准

- Telegram 配置：
  - 未设置 `TELEGRAM_ALLOWED_USER_ID` 时启动失败且报错信息明确；
  - 设置 `TELEGRAM_ALLOWED_USER_ID=123` 时启动通过；
  - 设置 `TELEGRAM_ALLOWED_USERS=123,456` 时启动失败；
  - 同时设置 `TELEGRAM_ALLOWED_USER_ID=123` 与 `TELEGRAM_ALLOWED_USERS=456` 时启动失败。
- 模型默认行为：
  - 未设置任何默认模型 override 时，执行任务不会强制设置为某个固定模型；
  - 当任务 `model=auto` 时，会显式清除 orchestrator 的 model override；
  - 当设置 `TELEGRAM_MODEL` / `TASK_QUEUE_DEFAULT_MODEL` 时，`auto` 会使用该 override。
- delegation 解析：
  - 覆盖包含多块、重复块、块内包含 `>>>` 字符串但不在单独一行的情况；
  - 未闭合块不会触发调用。
- crash handling：
  - `uncaughtException` / `unhandledRejection` 行为一致（记录 + best-effort close + 退出）。

## 验证方式（命令）

```bash
npx tsc --noEmit
npm run lint
npm test
```
