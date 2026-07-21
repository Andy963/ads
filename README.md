# ADS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

ADS 是一个面向 AI 编程工作流的本地 Web Console。它围绕项目、Planner/Worker 对话、任务草稿与队列、定时任务、技能和长期记忆组织工作，并可选通过 Telegram Bot 远程访问。

当前不支持把 ADS 当作独立的用户命令行产品使用。仓库里仍有 `server/cli.ts` 和 `package.json` 的 `bin` 配置，但它们只是构建后的服务启动入口和兼容包装；日常交互入口是 Web Console，Telegram Bot 是可选远程入口。

## 当前能力

- **Web Console**：登录保护的浏览器界面，支持项目列表、项目切换、Planner/Worker 双 lane 对话、WebSocket 流式输出、附件/图片、模型选择、Agent 切换和中断。
- **任务看板与队列**：支持创建、编辑、排序、运行、暂停、取消、重试、删除任务，并在任务终态记录结果与 workspace patch artifact。
- **任务草稿**：Planner 可生成 task bundle draft，Web UI 支持查看、编辑和审批，通过后加入任务队列。
- **多 Agent 适配**：Codex 是主要执行 Agent；Claude 和 Gemini 是可选协作 Agent，是否可用取决于本机二进制与凭据配置。
- **模型配置**：Web UI 可维护全局模型配置，配置存储在 ADS 全局 SQLite 状态库中。
- **定时任务**：Planner/Worker 输出 `ads-schedule` block 后，Web 服务会编译为 schedule spec，并由内置 scheduler 调度执行。
- **技能与记忆**：支持内置、状态目录、仓库级、全局和可选 workspace skills；支持 workspace soul、偏好指令和系统提示再注入。
- **Telegram Bot**：可选单用户 Bot，支持文本、图片、文件、语音转写、目录切换、偏好管理、笔记标记和中断当前任务。
- **集中状态存储**：Web 用户、会话、历史、模型配置等存储在全局 SQLite；任务、附件、队列、schedule 等按 workspace 隔离。

## 环境要求

- Node.js 20 或更新版本。
- npm 可用，并能构建 `better-sqlite3` native 依赖。
- Codex CLI 可用，默认从 `codex` 或 `ADS_CODEX_BIN` 解析。
- Claude/Gemini 为可选能力，默认从 `claude`、`gemini` 或对应 `ADS_*_BIN` 解析。
- Telegram Bot 仅在需要远程入口或任务通知时配置。

## 快速开始

```bash
git clone https://github.com/Andy963/ads.git
cd ads
npm install
npm run build
```

首次登录 Web Console 前需要创建管理员账号：

```bash
npm run web:init-admin -- --username admin --password-stdin
```

开发时启动 Web 服务：

```bash
npm run dev
```

使用构建产物启动 Web 服务：

```bash
npm run web
# or
npm start
```

默认监听 `127.0.0.1:8787`，浏览器访问 `http://127.0.0.1:8787`。

如果只改前端并需要 Vite 开发服务器：

```bash
npm run dev:web
```

`npm run dev:web` 会把 `/api` 和 `/ws` 代理到 `http://localhost:8787`，通常需要同时运行 Web 服务。

## 支持的服务入口

ADS 当前只把以下入口作为服务启动方式维护：

```bash
npm run dev
npm run web
npm start
```

`npm run web` 和 `npm start` 都会运行构建后的 `node dist/server/cli.js web`。这个文件名里的 `cli` 是历史实现细节，不代表 ADS 仍提供受支持的交互式 CLI 工作流。

Telegram Bot 需要先构建，并配置 token 与允许用户：

```bash
export TELEGRAM_BOT_TOKEN='your-bot-token'
export TELEGRAM_ALLOWED_USER_ID='123456789'
npm run build
node dist/server/cli.js telegram
```

`ads`、`ads-telegram` 这类 bin alias 仍可能随包产物存在，但 README 不再把它们列为推荐或支持入口。

## 常用脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run build` | TypeScript 构建、复制 runtime assets、构建 Web 前端 |
| `npm run build:web` | 仅构建 Web 前端 |
| `npm run dev` | 用 `tsx watch` 启动 Web 服务源码 |
| `npm run dev:web` | 启动 Vite 前端开发服务器 |
| `npm run web` | 启动构建后的 Web 服务 |
| `npm start` | 等同于启动构建后的 Web 服务 |
| `npm test` | 运行后端 Node test runner 测试 |
| `npm run test:web` | 运行前端 Vitest 组件测试 |
| `npm run coverage` | 生成 server 覆盖率报告 |
| `npm run lint` | 运行 ESLint |
| `npm run bundle` | 构建并生成更自包含的 `dist/` |
| `npm run web:init-admin` | 初始化 Web 管理员 |
| `npm run web:reset-admin` | 创建或重置第一个 Web 管理员 |
| `npm run skills:migrate` | 迁移 skill 数据 |
| `npm run codex:regen-types` | 重新生成 Codex app-server 类型 |

## 配置

ADS 会从当前目录向上查找 `.env`，并在同路径存在 `.env.local` 时用它覆盖；也可以通过 `ADS_ENV_PATH` 指定 env 文件。未设置 `CODEX_HOME` 时会自动解析默认 Codex 目录。

### 核心配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_STATE_DIR` | `<repo>/.ads` | ADS 全局状态目录 |
| `ADS_STATE_DB_PATH` | `$ADS_STATE_DIR/state.db` | 全局 SQLite 数据库路径 |
| `ALLOWED_DIRS` | 当前工作目录 | Web/Telegram 可访问目录，逗号分隔 |
| `SANDBOX_MODE` | `workspace-write` | `read-only`、`workspace-write` 或 `danger-full-access` |
| `ADS_ENV_PATH` | 未设置 | 显式指定 env 文件 |
| `ADS_DEBUG` | 未设置 | 设为 `1` 启用 debug 日志 |
| `ADS_LOG_FILE` / `ADS_LOG_DIR` | 未设置 | 日志输出文件或目录 |
| `ADS_LOG_STDOUT` | 未设置 | 控制日志是否镜像到 stdout |

### Web

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_WEB_HOST` | `127.0.0.1` | Web 监听地址 |
| `ADS_WEB_PORT` | `8787` | Web 监听端口 |
| `ADS_WEB_MAX_CLIENTS` | `32` | WebSocket 最大连接数 |
| `ADS_WEB_WS_PING_INTERVAL_MS` | `15000` | WebSocket ping 间隔 |
| `ADS_WEB_WS_MAX_MISSED_PONGS` | `3` | 断线前允许缺失 pong 次数 |
| `ADS_WEB_WS_MAX_PAYLOAD_BYTES` | `16777216` | 单个 WebSocket payload 上限 |
| `ADS_WEB_ALLOWED_ORIGINS` | 未设置 | 未设置时仅放行同源和 localhost |
| `ADS_WEB_SESSION_TTL_SECONDS` | `604800` | 登录 session cookie TTL |
| `ADS_WEB_SESSION_PEPPER` | 空 | session token hash pepper |
| `ADS_WEB_COOKIE_SECURE` | `auto` | Cookie Secure 策略 |
| `ADS_WEB_LOGIN_MAX_ATTEMPTS` | `5` | 登录失败锁定阈值 |
| `ADS_WEB_LOGIN_LOCKOUT_MS` | `300000` | 登录锁定基础时长 |
| `ADS_WEB_SESSION_SLIDING` | `false` | 是否滑动刷新登录 session |
| `ADS_WEB_SESSION_TIMEOUT_HOURS` | `24` | Web Agent 会话空闲超时 |
| `ADS_WEB_SESSION_TIMEOUT_MS` | 未设置 | Web Agent 会话超时毫秒覆盖 |
| `ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES` | `5` | 会话清理间隔 |
| `ADS_WEB_SESSION_CLEANUP_INTERVAL_MS` | 未设置 | 会话清理间隔毫秒覆盖 |
| `ADS_WEB_BASE_PATH` / `VITE_BASE_PATH` | `/` | 前端构建 base path |
| `ADS_PLANNER_CODEX_MODEL` | 未设置 | Planner lane Codex 模型覆盖 |
| `TASK_QUEUE_ENABLED` | `true` | 是否启用任务队列 |
| `TASK_QUEUE_AUTO_START` | `false` | Web 启动后是否自动运行队列 |
| `TASK_QUEUE_DEFAULT_MODEL` | 未设置 | 任务队列默认模型覆盖 |

### Agent 与协作

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_CODEX_BIN` | `codex` | Codex 二进制路径 |
| `ADS_CLAUDE_ENABLED` | 启用 | 设为 `0` 禁用 Claude |
| `ADS_CLAUDE_BIN` | `claude` | Claude 二进制路径 |
| `ADS_CLAUDE_MODEL` | 未设置 | Claude 模型覆盖 |
| `ADS_GEMINI_ENABLED` | 启用 | 设为 `0` 禁用 Gemini |
| `ADS_GEMINI_BIN` | `gemini` | Gemini 二进制路径 |
| `ADS_GEMINI_MODEL` | 未设置 | Gemini 模型覆盖 |
| `ADS_AGENT_PROBE_TIMEOUT_MS` | `5000` | Agent 可用性探测超时 |
| `ADS_AGENT_IDLE_TIMEOUT_MS` | `3600000` | Agent CLI 连续无 stdout/stderr 活动的空闲超时；有输出会续期，`0` 表示禁用 |
| `ADS_AGENT_MAX_RUN_TIMEOUT_MS` | `43200000` | 单次 Agent CLI 的最大墙钟运行时长，默认 12 小时，`0` 表示禁用 |
| `ADS_AGENT_RUN_TIMEOUT_MS` | 未设置 | 兼容旧配置；单独设置时保留旧版硬超时语义并禁用 idle watchdog，建议迁移到上面两个变量 |
| `ADS_CLI_POST_COMPLETION_GRACE_MS` | `10000` | CLI 输出终态结果后等待进程自然退出的宽限；超时则终止进程组并按成功收尾，`0` 表示禁用 |
| `ADS_CODEX_ADAPTER` | `auto` | Codex 适配器路径：`auto` 仅 Goal Mode 走 app-server；`app-server` 强制所有 codex 会话走 daemon（无 projectId 时按工作区派生）；`cli` 强制走一次性 CLI |
| `ADS_CODEX_DAEMON_ARGS` | 未设置 | 追加给 codex daemon 的全局参数（按空白拆分），用于按版本开启 collab 等实验特性，例如 `-c features.collab=true` |
| `ADS_UPSTREAM_RETRY_COUNT` | `1` | 临时上游模型错误的重试次数 |
| `ADS_TASK_UPSTREAM_RETRY_BASE_DELAY_MS` | `60000` | 外层上游重试耗尽后，任务级重试的初始持久化冷却时间；`0` 表示禁用冷却 |
| `ADS_TASK_UPSTREAM_RETRY_MAX_DELAY_MS` | `900000` | 外层上游重试耗尽后，任务级指数冷却的最大时间；`0` 表示禁用冷却 |
| `ADS_CLI_MAX_CONCURRENCY` | `4` | 单个 ADS 进程允许同时运行的 CLI 数量 |
| `ADS_CLI_MAX_PENDING` | `32` | CLI 并发已满时允许驻留内存的等待请求数，超出后立即失败 |
| `ADS_CLI_OUTPUT_MAX_BYTES` | `8388608` | 单次 CLI 分别保留的 stdout/stderr 最大字节数，超出时只保留尾部 |
| `ADS_COORDINATOR_ENABLED` | 未设置 | 是否启用多 Agent coordinator |
| `ADS_TASK_MAX_PARALLEL` | `3` | coordinator 最大并行委派数 |
| `ADS_TASK_TIMEOUT_MS` | `120000` | coordinator 单个委派任务超时 |
| `ADS_TASK_MAX_ATTEMPTS` | `2` | coordinator 委派任务尝试次数 |
| `ADS_TASK_RETRY_BACKOFF_MS` | `1200` | coordinator 重试退避 |
| `ADS_TASK_VERIFICATION_ENABLED` | `true` | 是否执行 TaskSpec verification commands |

Codex app-server 将 `willRetry=true` 的错误通知作为中间连接状态发送。ADS 会继续等待当前 turn；只有 `willRetry=false`、重连耗尽或收到其他终止错误后，才将请求标记为失败。

Agent 上游重试会识别限流/高负载、HTTP 503 Service Unavailable，以及 Claude Fable safeguard 的已知误拦截文案。仅在尚未产生命令、文件写入、工具调用等副作用时自动重放请求。

### 技能、记忆与系统提示

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_SKILLS_AUTOLOAD` | `true` | 自动加载匹配技能 |
| `ADS_SKILLS_AUTOSAVE` | `true` | 自动保存技能草稿 |
| `ADS_ENABLE_WORKSPACE_SKILLS` | 未设置 | 显式启用 workspace `.agent/skills` |
| `ADS_SKILLS_METADATA_PATH` | 未设置 | skill registry metadata 覆盖 |
| `ADS_PREFERENCE_DIRECTIVES` | `true` | 是否识别偏好写入指令 |
| `ADS_MEMORY_INJECTION_ENABLED` | `true` | 是否注入长期记忆 |
| `ADS_MEMORY_MAX_TOKENS` | `1024` | memory 注入 token 上限 |
| `ADS_SOUL_MAX_TOKENS` | `512` | soul 注入 token 上限 |
| `ADS_REINJECTION_ENABLED` | `true` | 是否再注入系统提示 |
| `ADS_REINJECTION_TURNS` | `6` | instructions 再注入轮次 |
| `ADS_RULES_REINJECTION_TURNS` | `1` | rules 再注入轮次 |
| `ADS_AUDIO_TRANSCRIPTION_TIMEOUT_MS` | `120000` | 语音转写单次 skill 超时 |
| `ADS_AUDIO_TRANSCRIPTION_SKILLS` | 未设置 | 语音转写 skill 优先级，逗号分隔 |

### Scheduler

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_SCHEDULER_ENABLED` | `true` | 是否启用 scheduler |
| `ADS_SCHEDULER_TICK_MS` | `5000` | 调度轮询间隔 |
| `ADS_SCHEDULER_IDLE_RECYCLE_MS` | 未设置 | 空闲回收间隔 |
| `ADS_SCHEDULER_LEASE_TTL_MS` | `30000` | schedule lease TTL |
| `ADS_SCHEDULER_DUE_LIMIT` | `20` | 单轮最多取出的 due schedules |
| `ADS_SCHEDULER_RECONCILE_LIMIT` | `200` | 单轮 reconcile 上限 |
| `ADS_SCHEDULER_RUNNER_POLL_MS` | `1000` | runner 轮询间隔 |
| `ADS_SCHEDULER_RUNNER_TIMEOUT_SECS` | `1800` | 单次 schedule 运行超时 |
| `ADS_SCHEDULER_RUNNER_CONCURRENCY` | `1` | schedule runner 并发数 |
| `ADS_SCHEDULER_MODEL` | `TASK_QUEUE_DEFAULT_MODEL` | schedule 执行模型 |
| `ADS_SCHEDULER_COMPILE_MODEL` | 未设置 | schedule 编译模型 |
| `ADS_SCHEDULER_COMPILE_TIMEOUT_MS` | `120000` | schedule 编译超时 |
| `ADS_SCHEDULER_COMPILE_MAX_ATTEMPTS` | `2` | schedule 编译尝试次数 |

### Telegram

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 必填 | Bot token |
| `TELEGRAM_ALLOWED_USER_ID` | 必填 | 单个允许用户 ID |
| `TELEGRAM_ALLOWED_USERS` | legacy | legacy alias，但当前只允许单个用户 ID |
| `TELEGRAM_MAX_RPM` | `10` | 每分钟请求限制 |
| `TELEGRAM_SESSION_TIMEOUT` | `24h` | Telegram Agent 会话超时，`0` 表示禁用 |
| `TELEGRAM_STREAM_UPDATE_INTERVAL` | `1500` | 流式消息更新间隔 |
| `TELEGRAM_MODEL` | 未设置 | Telegram 默认模型覆盖 |
| `TELEGRAM_PROXY_URL` | 未设置 | Telegram HTTP/HTTPS 代理 |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | 是否静默发送通知 |
| `ADS_PM2_APP_WEB` | 未设置 | Telegram restart web 命令使用的 pm2 app 名称 |
| `ADS_TG_ALLOW_SUICIDE_RESTART` | `false` | 非 pm2 场景是否允许自重启 |
| `ADS_TELEGRAM_NOTIFY_TIMEZONE` | `Asia/Shanghai` | Web 任务终态通知时区 |

Web 任务终态通知会复用 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_ALLOWED_USER_ID`，发送到同一个 user id 对应的 chat id。

## Web 使用要点

- 首次登录前必须运行 `npm run web:init-admin`。
- 默认 `default` project 绑定到 `ALLOWED_DIRS` 的第一个目录；也可以在 Web UI 添加、移除、排序项目。
- Web Worker lane 默认用于实际执行，Planner lane 用于规划和任务草稿。
- Worker 执行过程中只展示最新一条命令预览；连接恢复后，一旦收到新的命令、流式活动或同步到命令结果，重连/等待状态提示会立即消失，但当前 turn 仍保持忙碌直到收到最终结果。服务端会在 welcome 中声明是否紧随 bootstrap history，客户端据此先对账未确认请求再决定是否重发，避免重复执行或永久锁定输入；恢复历史继续到命令活动时会丢弃断线前未完成的 assistant 片段。恢复上下文期间完成的语音转写仍会保留到当前输入草稿。
- Web 内置 `/pwd` 和 `/cd <path>`；旧的用户可见 `/ads.*` slash 规划命令已停用，任务草稿和审批由 UI 与 Planner 流程驱动。
- Goal Mode 依赖 Codex app-server 正常启动；普通 Worker/任务执行依赖 Codex CLI。
- Web 服务启动时会同步 runtime templates，并启动 scheduler、任务队列管理器、Agent 可用性探测和 Telegram 任务通知重试循环。

## Telegram 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎信息 |
| `/help` | 命令帮助 |
| `/status` | 系统状态 |
| `/reset` | 重置会话，开始新对话 |
| `/resume` | 当前实现会提示使用 `/reset` |
| `/esc` | 中断当前任务，Agent 进程保留 |
| `/mark [on\|off]` | 将后续对话记录到当天 note |
| `/pref [list\|add\|del]` | 管理长期偏好 |
| `/pwd` | 查看当前工作目录 |
| `/cd <path>` | 在 `ALLOWED_DIRS` 约束内切换工作目录 |

## 数据与目录布局

默认全局状态目录为仓库根目录下 `.ads/`：

```text
.ads/
├── state.db
├── run/
│   └── web.pid
├── .agent/
│   └── skills/
└── workspaces/
    └── <workspace-id>/
        ├── ads.db
        ├── workspace.json
        ├── templates/
        └── ...
```

`state.db` 保存 Web 用户、登录会话、历史、模型配置、全局草稿等状态。每个 workspace 会在 `.ads/workspaces/<workspace-id>/` 下维护独立 `ads.db` 和模板/运行时状态。历史版本的 workspace 内 `.ads/` 会被尽力迁移到集中状态目录。

## 项目结构

```text
ads/
├── server/
│   ├── agents/        # Codex / Claude / Gemini adapters, coordination, probes
│   ├── codex/         # Codex app-server protocol and RPC client
│   ├── context/       # context compaction and token estimation
│   ├── memory/        # soul, preference directives, markdown memory
│   ├── scheduler/     # schedule spec compiler and runtime
│   ├── skills/        # skill discovery, loading, creation, built-in tools
│   ├── state/         # global SQLite schema, migrations, stores
│   ├── storage/       # workspace SQLite schema, migrations, stores
│   ├── systemPrompt/  # instructions, rules, supervisor injection
│   ├── tasks/         # task model, queue, executor, store
│   ├── telegram/      # Telegram bot, commands, attachments, voice
│   ├── web/           # Web server, API, WebSocket, auth, task queue
│   └── workspace/     # workspace detection, paths, template sync
├── client/            # Vue 3 + Vite Web UI
├── tests/             # backend Node test runner tests
├── templates/         # runtime prompt and workspace templates
├── scripts/           # build, bundle, type generation helpers
└── docs/              # project documentation
```

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
npm run test:web
npm run build
```

只修改 README 时，通常重点检查文档里的命令、路径和环境变量是否仍能在代码中找到；涉及 TypeScript 或前端代码时再运行完整验证。

## 安全提示

- 不要提交 `.env`、`.env.local`、token、cookie 或 Agent 凭据。
- Web 必须初始化管理员账号；公网部署应配置 TLS、`ADS_WEB_ALLOWED_ORIGINS`、`ADS_WEB_SESSION_PEPPER` 和 `ADS_WEB_COOKIE_SECURE=true`。
- Telegram 必须限制 `TELEGRAM_ALLOWED_USER_ID`，当前实现不是多用户 Bot。
- `ALLOWED_DIRS` 应尽量收窄到可信工作区；谨慎使用 `SANDBOX_MODE=danger-full-access`。
- 泄露的 Telegram token、Agent API key 或 CLI 凭据应立即撤销并轮换。

## License

MIT License. See [LICENSE](LICENSE).
