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

## 模型服务、角色与 Web 语音配置

「模型配置」的第一个标签是服务商（Providers），之后是对话（Conversation）、转录（Transcription）、纠错（Correction）三个服务。服务商及模型目录由服务端统一管理；服务只保存启用模型和默认模型的引用，不复制连接或模型配置。语音阶段选项及加密凭据属于当前登录账户，跨项目和设备共享。

### 服务商（多上游）

「模型配置 → 服务商」管理命名的上游服务商：名称、Base URL、API 密钥与可选的 Wire API 提示（默认 `responses`）。可随时查看和编辑已有服务商；相同地址下留空密钥表示保留，更换服务地址必须重新填写匹配的新密钥。密钥仅保存在服务端 AES-256-GCM 加密存储中，读取接口只返回是否已配置，不返回密钥。

每个服务商下面列出其模型，可以同步上游目录，也可以手动添加、编辑名称和模型选项。同步只新增模型，不覆盖已有别名、选项或推理强度，也不自动启用新模型。不同服务商的同名模型以配置 ID 区分。旧的未关联模型保留在待关联分组中，需要手动指定服务商。

- `codex-app-server` 运行时通过 `-c model_providers.*` 覆盖把服务商注入 `codex app-server` 进程，密钥只出现在该进程的环境变量中（`env_key` 引用），从不出现在命令行参数里；切换服务商会在下一次请求时启动新的 daemon。
- `native` 运行时经保存的模型配置解析服务商的服务地址与加密密钥，仅支持 Chat completions；显式配置 Responses 或其他格式会在请求前报错，不会静默发送到另一种协议端点。
- 删除模型（包括旧的未关联模型）前会明确确认同时移除服务引用；删除默认模型时选择剩余候选，没有候选则清空默认。引用该模型的角色改用剩余的对话默认模型。引用调整与删除在同一事务中执行，失败时全部回滚。删除服务商仍需先移除其服务引用；删除服务商不会删除关联模型，模型保留为待关联。

### 服务启用与默认模型

三个服务均可从目录启用多个候选。非空候选列表必须指定且只能指定一个默认模型；没有候选时默认模型为空。

- **对话**：Acopilot、Actions 顶部选择器和角色设置只能选择已启用的对话模型。默认推理强度为 `high`，默认选项为 `medium`、`high`，不按推测的模型能力隐藏。模型选项可显式配置其他支持的强度。
- **转录、纠错**：候选可以有多个，但每次请求只使用各自的默认模型，不并行调用、轮询或自动切换候选。两阶段的默认选择在请求开始时固定；中途修改默认只影响下一次请求。
- 连接地址及密钥只在服务商处编辑。转录和纠错页面分别保存其候选、默认模型及阶段选项，不再填写另一份连接信息。

移动端采用底部四个服务标签、分组列表和整行点击。启用开关自动保存，失败时恢复原状态；默认模型在独立单选页选择。连接和阶段选项通过编辑页顶部的完成按钮提交，取消未保存编辑时需要确认丢弃。聊天切换反馈使用模型别名或上游名称，不显示内部配置 ID。

抽屉、主界面、模型管理与角色指令共用系统字体、背景、强调色、分隔线和圆角变量。移动端模型页使用 22px 标题和紧凑留白；角色切换条高 36px，可在角色栏或非编辑区左右滑动切换，保留未保存草稿，不干扰编辑器的文本选择、纵向滚动或屏幕边缘导航。

用户与 Agent 消息操作行均先显示时间，再显示按钮。Acopilot 和 Actions 的失败消息重试在各自会话内重放原消息，保留消息标识、模型及推理强度；状态栏显示等待发送、等待连接或已发送反馈，不重复新增用户消息。Actions 执行任务期间仍禁止插入重试，并显示阻塞原因。

排队消息与任务队列沿用相同的分组配色和圆角。消息卡片最多显示三行并可内部滚动，多条积压时由外层队列滚动，不压缩卡片；任务状态、截断标题及操作按钮保持紧凑同行。重试成功时只清除结果对应的队列卡片，不影响后续排队消息。

主界面点击模型／强度入口后，使用同样的分组列表编辑页选择模型。推理强度采用离散滑块，档位按所选模型的配置从低到高排列，拖动预览，松手提交；也支持键盘方向键调整。只有一个配置档位时不可拖动，断线或运行锁定时不可修改。

### 语音阶段选项与迁移

- **转录**：语言默认 `zh`，留空自动检测，可设置专用提示词，最大上传 25 MiB。需要在目录中配置可转录音频的模型并将其设为该服务默认。
- **纠错**：默认关闭，可编辑专用系统提示词（最多 8000 字符，不允许空白），恢复默认只修改表单，保存后生效。高级设置可调整思考强度（默认高）和纠错超时。
- 两阶段分别解析所选模型所属服务商的密钥；可以使用同一服务商，也可以使用不同服务商。浏览器不持久化密钥输入，离开服务商编辑框会清空未提交密钥。
- 保存一个阶段的选项不会覆盖另一个阶段，也不依赖上游连接成功。
- 默认转写超时 120 秒，纠错 15 秒，总处理 135 秒；范围均为 1–180 秒，无自动重试。纠错失败或超时保留原始转写。
- **测试已保存的配置** 位于语音转写页：上传所选音频，只使用已保存设置，不保存草稿；启用纠错时还会调用纠错服务，可能产生费用。

旧 UI 语音连接会迁入服务商和模型目录，复用原加密凭据引用；迁移后的语音记录只保存阶段选项，不再保留模型、地址或密钥副本。旧版纠错对话模型引用不会自动借用对话密钥，需在目录及纠错服务中明确配置。旧配置缺少系统提示词时使用默认纠错指令。原环境变量中的语言、提示词、超时可手工填写到对应表单。

Web 路径不读取原语音环境变量、Groq 环境密钥或 Codex 凭据，不自动导入秘密，不回退到技能。未配置、禁用、损坏或解密失败均不会激活环境回退。全局转写技能及独立 CLI 用法不受影响。

### 单份角色配置

Acopilot、Developer、Reviewer 各自只保存一条当前角色配置。角色页的模型和推理强度位于指令下方，采用与模型管理一致的分组列表和单选编辑页；选择即保存对应字段，系统指令通过保存按钮单独提交。模型保存失败或未配置可用模型均不会丢弃、阻止保存指令草稿，重新选择旧模型名对应的模型会写入其配置 ID。角色页面不维护历史版本或另一份指令副本。迁移以旧角色编辑器实际显示的当前指令为准，合并到角色表后移除旧版本表和指针表。数据库迁移只会在使用新版本启动时执行，修改源码本身不会迁移运行数据库。

## Reviewer 只读检查

`ADS_REVIEWER_TOOL_TURNS` 配置 Reviewer 工具回合上限，默认 `5`，接受 `0` 至 `10` 的整数；`0` 禁用工具探索但仍请求最终判定。每回合最多四个串行工具调用，文件读取最多 100 行，累计工具输出约 40,000 字符。超出预算后强制最终 JSON，不能继续调用工具。

Reviewer 的模型、推理强度和 system prompt 来自角色配置；连接使用任务所有者的 HTTP 模型配置和凭据。仅配置 Codex CLI 登录而无可用 HTTP 连接不能保证 Reviewer 可用。检查对象是精确被审查提交，不是未提交工作区；不支持写入、shell、符号链接或子模块检查。详见 ADR 0033。
