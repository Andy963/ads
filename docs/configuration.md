# ADS 完整环境变量参考手册

ADS 会在启动时从当前工作目录向上查找 `.env` 文件，并自动合并 `.env.local` 中的覆盖配置。也可以通过 `ADS_ENV_PATH` 显式指定配置路径。

---

## 1. 核心与系统基础配置

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_STATE_DIR` | `<repo>/.ads` | ADS 全局状态目录，存放 `state.db` 及全局运行时数据 |
| `ADS_STATE_DB_PATH` | `$ADS_STATE_DIR/state.db` | 全局 SQLite 数据库路径覆盖 |
| `ALLOWED_DIRS` | 当前运行目录 | Web Console 与 Telegram 允许访问/切换的工作区根目录列表（逗号分隔） |
| `SANDBOX_MODE` | `workspace-write` | Codex/Worker 默认沙箱权限：`read-only`、`workspace-write` 或 `danger-full-access`；Native Runtime 不提供 sandbox isolation，命令直接宿主机执行 |
| `ADS_ENV_PATH` | 未设置 | 显式指定被加载的 `.env` 配置文件绝对路径 |
| `ADS_DEBUG` | `0` | 设为 `1` 启用 Debug 级别详细日志 |
| `ADS_LOG_FILE` / `ADS_LOG_DIR` | 未设置 | 运行时日志输出文件或目录 |
| `ADS_LOG_STDOUT` | 未设置 | 控制日志是否同时镜像输出至 stdout |

---

## 2. Web 服务与安全配置

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_WEB_HOST` | `127.0.0.1` | HTTP 与 WebSocket 监听地址 |
| `ADS_WEB_PORT` | `8787` | HTTP 与 WebSocket 监听端口 |
| `ADS_WEB_MAX_CLIENTS` | `32` | 允许同时建立的最大 WebSocket 客户端连接数 |
| `ADS_WEB_WS_PING_INTERVAL_MS` | `15000` | WebSocket 心跳 Ping 间隔（毫秒） |
| `ADS_WEB_WS_MAX_MISSED_PONGS` | `3` | 判定连接断开前允许连续丢失的心跳 Pong 次数 |
| `ADS_WEB_WS_MAX_PAYLOAD_BYTES` | `16777216` (16MB) | 单个 WebSocket 帧的最大允许字节数 |
| `ADS_WEB_ALLOWED_ORIGINS` | 未设置 | 跨域与 WebSocket 握手白名单，未设置仅放行同源与 localhost |
| `ADS_WEB_SESSION_TTL_SECONDS` | `604800` (7天) | 登录状态认证 Cookie 的有效期 |
| `ADS_WEB_SESSION_PEPPER` | 空 | 密码与 Session Token 哈希增强混淆盐值 |
| `ADS_WEB_COOKIE_SECURE` | `auto` | 认证 Cookie 的 Secure 属性 (`auto` / `true` / `false`) |
| `ADS_WEB_LOGIN_MAX_ATTEMPTS` | `5` | 触发 IP 锁定的连续密码错误阈值 |
| `ADS_WEB_LOGIN_LOCKOUT_MS` | `300000` (5分钟) | 触发锁定后的基础冷却时长 |
| `ADS_WEB_SESSION_SLIDING` | `false` | 是否开启滑动刷新 Session 有效期 |
| `ADS_ADVISOR_CODEX_MODEL` | 未设置 | Advisor Lane 专用的 Codex 模型覆盖（旧名 `ADS_PLANNER_CODEX_MODEL` 仍兼容，已弃用） |
| `ADS_ADVISOR_SANDBOX_MODE` | `danger-full-access` | Codex/Advisor Lane 沙箱权限覆盖；用于需要调用 GitHub CLI 的场景。非法值安全回退为 `workspace-write`（旧名 `ADS_PLANNER_SANDBOX_MODE` 仍兼容，已弃用）；不影响 Native Runtime 的直接宿主机执行语义 |
| `ADS_SCHEDULER_MODEL` | 未设置 | Scheduler 执行定时 Prompt 时使用的模型覆盖 |

---

## 3. Agent 运行时与执行器配置

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_AGENT_RUNTIME` | `codex-app-server` | Agent 运行时后端：`codex-app-server`（默认，经 Codex App-Server daemon）或 `native`（进程内原生运行时，直连 OpenAI 兼容端点；兼容别名 `in-process`） |
| `ADS_CODEX_BIN` | `codex` | Codex 二进制执行文件路径或别名；ADS 通过 `codex app-server` 启动 |
| `ADS_AGENT_PROBE_TIMEOUT_MS` | `5000` | 启动时探测 Agent 可用性的超时时间（毫秒） |
| `ADS_AGENT_IDLE_TIMEOUT_MS` | `3600000` (1小时) | CLI 连续无标准输出/错误的空闲看门狗超时，`0` 表示禁用 |
| `ADS_AGENT_MAX_RUN_TIMEOUT_MS` | `43200000` (12小时)| 单次 CLI 运行的最大硬超时保护，`0` 表示禁用 |
| `ADS_CLI_POST_COMPLETION_GRACE_MS`| `10000` (10秒) | CLI 报告终态结果后等待其正常退出的宽限时长 |
| `ADS_UPSTREAM_RETRY_COUNT` | `1` | 遭遇上游网络/服务故障时的自动安全重试次数 |
| `ADS_CLI_MAX_CONCURRENCY` | `4` | 单机允许并发执行的 Agent CLI 最大数量 |
| `ADS_CLI_MAX_PENDING` | `32` | 并发占满时进入排队等待的最大请求队列长度 |
| `ADS_CLI_OUTPUT_MAX_BYTES` | `8388608` (8MB) | 单次运行捕获的 stdout/stderr 最大保留体积 |

---

## 4. 原生运行时 (Native Runtime)

仅当 `ADS_AGENT_RUNTIME=native` 时生效。`ADS_AGENT_RUNTIME` 是进程级、互斥的 backend 选择；session 生命周期内不能切换到 Codex app-server，也不能跨 backend resume。逻辑 agent `codex`、runtime backend、execution session、provider session 和 ADS transcript 是不同身份，详见 [ADR 0026](adr/0026-native-runtime-lifecycle-and-capability-contract.md)。

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_AGENT_MAX_TOOL_ROUNDS` | `0`（不限制） | 单次 turn 内模型-工具循环的最大轮数；仅配置正整数时才启用上限，达到上限返回正常的 continuation notice（兼容旧名 `ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS`） |
| `ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS` | `0`（不限制） | 原生 turn 的总 wall-clock 超时（毫秒），上限 `600000`；`0` 或未设置时 turn 仅受用户取消与各工具自身超时约束 |

### Native lifecycle 与 capability 边界

- `durable` Web/Actions Developer session 将 completed Native turn 保存到 ADS state store；`ephemeral` session（包括独立 Actions Reviewer session）始终新建，并在使用后释放。
- 只有 completed turn 才会恢复。interrupted、failed 和 cancelled turn 保留审计记录，但不会作为成功上下文重放；下一次 provider request 使用 durable transcript 的 token-budgeted projection。
- Native command 直接在宿主机执行，保留现有 safety、allowlist、timeout、output 和 cancellation 检查，并继承宿主 environment 与 `$HOME`。运维不能把 `native` 视为 Codex app-server sandbox 的等价模式。
- Provider capability 为 `supported`、`unsupported` 或 `unknown`。请求 unsupported 或 unknown 能力时，在 provider request 前以结构化 `NATIVE_CAPABILITY_UNSUPPORTED` error 失败，不做静默降级。

---

## 5. 技能、记忆与安全系统

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_SKILLS_AUTOLOAD` | `true` | 是否根据 Prompt 自动匹配加载相关技能 |
| `ADS_SKILLS_AUTOSAVE` | `true` | 是否自动将对话生成的技能（`<skill_save>` 块）沉淀至全局 `$CODEX_HOME/skills` 目录 |
| `ADS_MIGRATE_LEGACY_SKILLS` | `1` | 是否在技能加载时自动非破坏性迁移遗留的 `$ADS_STATE_DIR/.agent/skills` 技能到 `$CODEX_HOME/skills`（设为 `0` 可关闭） |
| `ADS_MEMORY_INJECTION_ENABLED` | `true` | 是否在系统提示中动态注入工作区长期记忆 |
| `ADS_MEMORY_MAX_TOKENS` | `1024` | 注入长期记忆的最大 Token 预算 |
| `ADS_SOUL_MAX_TOKENS` | `512` | 注入工作区 Soul 偏好的最大 Token 预算 |
| `ADS_REINJECTION_TURNS` | `6` | 系统 Instructions 周期性重新注入的轮次间隔 |
| `ADS_RULE_ENFORCEMENT_MODE` | `observe` | 兼容性日志模式；内置安全拦截始终执行，不由该变量放宽 |

---

## 6. 定时调度器 (Scheduler)

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_SCHEDULER_ENABLED` | `true` | 是否开启内置 Scheduler 调度引擎 |
| `ADS_SCHEDULER_TICK_MS` | `5000` | 调度轮询触发周期（毫秒） |
| `ADS_SCHEDULER_RUNNER_CONCURRENCY` | `1` | 定时任务的最大并发执行数 |
| `ADS_SCHEDULER_RUNNER_TIMEOUT_SECS` | `1800` (30分钟)| 单次定时任务运行的硬超时时间（秒） |
| `ADS_SCHEDULER_COMPILE_TIMEOUT_MS` | `120000` | 定时指令自然语言编译的超时时限 |

---

## 7. Optional Telegram Connector

Telegram variables belong to the standalone `connectors/telegram` package and are not read by ADS Core.

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填 | Telegram Connector 的 Bot 访问 Token |
| `TELEGRAM_ALLOWED_USER_ID` | 必填 | 唯一授权操作的 Telegram 用户数字 ID |
| `ADS_CORE_URL` | `http://127.0.0.1:8787` | ADS Core HTTP 地址 |
| `ADS_CORE_WS_URL` | Derived | ADS Core WebSocket 地址 |
| `ADS_CONNECTOR_TOKEN` | 必填 | Core connector bearer token；Connector 与 Core 必须配置为同一值 |
| `ADS_CONNECTOR_USER_ID` | `connector` | Bearer connector 的逻辑用户 ID |
| `TELEGRAM_MAX_REQUESTS_PER_MINUTE` | `30` | 每分钟最高请求频率限制 |
| `TELEGRAM_PROXY_URL` | 未设置 | 网络代理地址（如 `http://127.0.0.1:7890`） |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | 是否静默推送任务完成通知 |
| `TELEGRAM_NOTIFICATION_CHAT_ID` | 未设置 | 接收异步任务终态通知的 Chat ID |

## Web 语音输入配置与迁移

在「模型配置」中分别打开 **语音转写** 和 **文本纠错**。两个页面独立编辑、独立保存，不显示角色指令；移动端隐藏外层标签时仍可进入。设置属于当前登录账户，跨项目和设备共享。

- **语音转写**：填写 Groq 服务地址、API 密钥，选择 `whisper-large-v3` 或 `whisper-large-v3-turbo`。默认服务地址为 `https://api.groq.com/openai/v1`，语言默认 `zh`，留空自动检测，最大上传 25 MiB。
- **文本纠错**：默认关闭。直接填写独立的 OpenAI 兼容服务地址、API 密钥、模型名称；无需选择、创建或修改对话模型，不复用角色或聊天连接。可编辑专用系统提示词（最多 8000 字符，不允许空白），恢复默认只修改表单，保存后生效。高级设置可调整思考强度（默认高）和纠错超时。
- 两个阶段使用不同的加密凭据配置。读取接口仅提供密钥存在状态，不返回密钥。端点不变时可留空保留密钥，更换端点必须显式填写匹配的新密钥；浏览器不持久化密钥输入，离开页面会清空未提交密钥。
- 保存某个页面不会覆盖另一个页面的设置，也不依赖模型列表查询或上游连接成功。
- 默认转写超时 120 秒，纠错 15 秒，总处理 135 秒；范围均为 1–180 秒，无自动重试。纠错失败或超时保留原始转写。
- **测试已保存的配置** 位于语音转写页：上传所选音频，只使用已保存设置，不保存草稿；启用纠错时还会调用纠错服务，可能产生费用。

原转写环境变量中的语言、提示词、超时可手工填写到对应表单。原纠错环境变量或旧版对话模型引用需改为在「文本纠错」中直接填写连接和模型；不会自动复制或借用旧模型的密钥。旧配置缺少系统提示词时使用默认纠错指令，不改变已有连接或密钥。已有 UI 转写配置及密钥保留，旧纠错引用尚未重新配置时保留原始转写并提示纠错配置不可用。

Web 路径不读取原语音环境变量、Groq 环境密钥或 Codex 凭据，不自动导入秘密，不回退到技能。未配置、禁用、损坏或解密失败均不会激活环境回退。全局转写技能及独立 CLI 用法不受影响。

## Reviewer 只读检查

`ADS_REVIEWER_TOOL_TURNS` 配置 Reviewer 工具回合上限，默认 `5`，接受 `0` 至 `10` 的整数；`0` 禁用工具探索但仍请求最终判定。每回合最多四个串行工具调用，文件读取最多 100 行，累计工具输出约 40,000 字符。超出预算后强制最终 JSON，不能继续调用工具。

Reviewer 的模型、推理强度和 system prompt 来自角色配置；连接使用任务所有者的 HTTP 模型配置和凭据。仅配置 Codex CLI 登录而无可用 HTTP 连接不能保证 Reviewer 可用。检查对象是精确被审查提交，不是未提交工作区；不支持写入、shell、符号链接或子模块检查。详见 ADR 0033。
