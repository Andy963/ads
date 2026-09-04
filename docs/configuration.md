# ADS 完整环境变量参考手册

ADS 会在启动时从当前工作目录向上查找 `.env` 文件，并自动合并 `.env.local` 中的覆盖配置。也可以通过 `ADS_ENV_PATH` 显式指定配置路径。

---

## 1. 核心与系统基础配置

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_STATE_DIR` | `<repo>/.ads` | ADS 全局状态目录，存放 `state.db` 及全局运行时数据 |
| `ADS_STATE_DB_PATH` | `$ADS_STATE_DIR/state.db` | 全局 SQLite 数据库路径覆盖 |
| `ALLOWED_DIRS` | 当前运行目录 | Web Console 与 Telegram 允许访问/切换的工作区根目录列表（逗号分隔） |
| `SANDBOX_MODE` | `workspace-write` | Agent 默认沙箱权限：`read-only`、`workspace-write` 或 `danger-full-access` |
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
| `ADS_PLANNER_CODEX_MODEL` | 未设置 | Advisor (规划 Lane) 专用的 Codex 模型覆盖 |
| `ADS_PLANNER_SANDBOX_MODE` | `danger-full-access` | Advisor Lane 沙箱权限覆盖；用于需要调用 GitHub CLI 的场景。非法值安全回退为 `workspace-write` |
| `ADS_SCHEDULER_MODEL` | 未设置 | Scheduler 执行定时 Prompt 时使用的模型覆盖 |

---

## 3. Agent CLI 与执行器配置

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_CODEX_BIN` | `codex` | Codex 二进制执行文件路径或别名；ADS 通过 `codex app-server` 启动 |
| `ADS_CLAUDE_ENABLED` | `1` (启用) | 设为 `0` 完全禁用 Claude Code 适配器 |
| `ADS_CLAUDE_BIN` | `claude` | Claude Code CLI 二进制执行文件路径 |
| `ADS_CLAUDE_MODEL` | 未设置 | Claude 默认使用的模型 ID 覆盖 |
| `ADS_AGENT_PROBE_TIMEOUT_MS` | `5000` | 启动时探测 Agent 可用性的超时时间（毫秒） |
| `ADS_AGENT_IDLE_TIMEOUT_MS` | `3600000` (1小时) | CLI 连续无标准输出/错误的空闲看门狗超时，`0` 表示禁用 |
| `ADS_AGENT_MAX_RUN_TIMEOUT_MS` | `43200000` (12小时)| 单次 CLI 运行的最大硬超时保护，`0` 表示禁用 |
| `ADS_CLI_POST_COMPLETION_GRACE_MS`| `10000` (10秒) | CLI 报告终态结果后等待其正常退出的宽限时长 |
| `ADS_UPSTREAM_RETRY_COUNT` | `1` | 遭遇上游网络/服务故障时的自动安全重试次数 |
| `ADS_CLI_MAX_CONCURRENCY` | `4` | 单机允许并发执行的 Agent CLI 最大数量 |
| `ADS_CLI_MAX_PENDING` | `32` | 并发占满时进入排队等待的最大请求队列长度 |
| `ADS_CLI_OUTPUT_MAX_BYTES` | `8388608` (8MB) | 单次运行捕获的 stdout/stderr 最大保留体积 |

---

## 4. 技能、规则与记忆系统

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_SKILLS_AUTOLOAD` | `true` | 是否根据 Prompt 自动匹配加载相关技能 |
| `ADS_SKILLS_AUTOSAVE` | `true` | 是否自动将对话生成的技能草稿沉淀至草稿目录 |
| `ADS_ENABLE_WORKSPACE_SKILLS` | 未设置 | 是否显式允许工作区目录下的 `.agent/skills` |
| `ADS_PREFERENCE_DIRECTIVES` | `true` | 是否在对话中自动识别并提取用户长期偏好 |
| `ADS_MEMORY_INJECTION_ENABLED` | `true` | 是否在系统提示中动态注入工作区长期记忆 |
| `ADS_MEMORY_MAX_TOKENS` | `1024` | 注入长期记忆的最大 Token 预算 |
| `ADS_SOUL_MAX_TOKENS` | `512` | 注入工作区 Soul 偏好的最大 Token 预算 |
| `ADS_REINJECTION_TURNS` | `6` | 系统 Instructions 周期性重新注入的轮次间隔 |
| `ADS_RULES_REINJECTION_TURNS` | `8` | Global Rules 重新注入的轮次间隔（规则内容变更时立即注入，不受此间隔限制） |
| `ADS_RULE_ENFORCEMENT_MODE` | `observe` | 全局规则执行模式：`observe`（仅监控记录）或 `enforce`（硬阻断生效） |
| `ADS_AUDIO_TRANSCRIPTION_TIMEOUT_MS`| `120000` | 语音转写处理的单次超时时限（毫秒） |

---

## 5. 定时调度器 (Scheduler)

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_SCHEDULER_ENABLED` | `true` | 是否开启内置 Scheduler 调度引擎 |
| `ADS_SCHEDULER_TICK_MS` | `5000` | 调度轮询触发周期（毫秒） |
| `ADS_SCHEDULER_RUNNER_CONCURRENCY` | `1` | 定时任务的最大并发执行数 |
| `ADS_SCHEDULER_RUNNER_TIMEOUT_SECS` | `1800` (30分钟)| 单次定时任务运行的硬超时时间（秒） |
| `ADS_SCHEDULER_COMPILE_TIMEOUT_MS` | `120000` | 定时指令自然语言编译的超时时限 |

---

## 6. Telegram Bot

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填 | Telegram Bot 访问 Token |
| `TELEGRAM_ALLOWED_USER_ID` | 必填 | 唯一授权操作的 Telegram 用户数字 ID |
| `TELEGRAM_MAX_RPM` | `10` | 每分钟最高请求频率限制 |
| `TELEGRAM_SESSION_TIMEOUT` | `24h` | Telegram Agent 会话空闲保持超时 |
| `TELEGRAM_STREAM_UPDATE_INTERVAL` | `1500` | Telegram 消息流式更新频率（毫秒） |
| `TELEGRAM_PROXY_URL` | 未设置 | 网络代理地址（如 `http://127.0.0.1:7890`） |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | 是否静默推送任务完成通知 |
| `ADS_TELEGRAM_NOTIFY_TIMEZONE` | `Asia/Shanghai` | 任务通知卡片中显示时间采用的时区 |
