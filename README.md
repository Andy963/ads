# ADS - AI Driven Specification

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

ADS 是一个面向 AI 编程工作流的本地控制台：通过 Web UI 和 Telegram Bot 管理项目、Planner/Worker 对话、任务队列、规格草稿、定时任务和多 Agent 执行。

## 功能概览

- **Web Console**：登录保护的浏览器控制台，支持项目切换、Planner/Worker 双通道聊天、流式输出、图片附件、文件预览和模型选择。
- **任务看板与队列**：创建、排序、运行、重试、取消任务；支持单任务执行和队列运行/暂停。
- **规格草稿**：Planner 可生成 task bundle draft，并维护 `requirement`、`design`、`implementation` 等规格文件后再审批落地为任务。
- **多 Agent**：Codex 为默认执行 Agent；可选启用 Claude Code / Gemini CLI；Goal Mode 使用 Codex app-server 适配器。
- **模型管理**：在 Web UI 中维护全局模型配置（Codex / Claude 分组、启用状态、provider 和 JSON 配置）。
- **定时任务**：内置 scheduler，可编译自然语言计划并按运行时调度任务。
- **记忆与偏好**：支持偏好指令、workspace soul、系统提示和 rules 再注入。
- **Telegram Bot**：单用户远程控制，支持文本、图片、文件、语音转写、目录切换、偏好管理和中断当前任务。
- **集中状态存储**：全局状态、会话、历史、模型配置、Web 用户等存入 SQLite；workspace 任务数据按项目隔离。

## 环境要求

- Node.js 20 或更新版本。
- 已安装并登录所需 Agent CLI：至少需要 `codex`；可选 `claude`、`gemini`。
- `better-sqlite3` native 依赖需能在当前平台构建（通常 `npm install` 会自动处理）。

## 快速开始

```bash
git clone https://github.com/Andy963/ads.git
cd ads
npm install
npm run build
```

### 初始化 Web 管理员

首次打开 Web Console 前需要创建管理员账号；系统不会内置默认账号。

```bash
npm run web:init-admin -- --username admin --password-stdin
# 或显式传入密码（不推荐写入 shell 历史）
npm run web:init-admin -- --username admin --password 'your-password'
```

如需重置第一个管理员账号：

```bash
npm run web:reset-admin -- --username admin --password-stdin
```

### 启动 Web Console

```bash
npm run web
# 等价于构建后的 CLI
node dist/server/cli.js web
# 或
npm start
```

默认监听 `127.0.0.1:8787`，浏览器访问 `http://127.0.0.1:8787`。

## 常用脚本

```bash
npm run build          # TypeScript 构建 + 复制 runtime assets + Vite 构建
npm run build:web      # 仅构建前端
npm run dev            # tsx watch server/web/server.ts
npm run dev:web        # Vite 前端开发服务器
npm run web            # 启动编译后的 Web Console
npm start              # 启动编译后的 Web Console
npm test               # Node test runner 跑 tests/**/*.test.ts
npm run test:web       # Vitest 跑 client 组件测试
npm run coverage       # c8 覆盖率（server，排除 telegram）
npm run lint           # ESLint
npm run bundle         # 构建并生成更自包含的 dist/
npm run web:init-admin # 初始化 Web 管理员
npm run web:reset-admin# 创建/重置第一个 Web 管理员
```

## CLI

构建后可使用：

```bash
node dist/server/cli.js help
node dist/server/cli.js version
node dist/server/cli.js web
node dist/server/cli.js telegram
```

安装为 bin 后：

```bash
ads web
ads telegram
ads-telegram
```

## 核心配置

ADS 会向上查找 `.env`，并在存在时加载同路径 `.env.local` 覆盖；也可用 `ADS_ENV_PATH` 指向指定 env 文件。未设置 `CODEX_HOME` 时会自动解析默认目录。

### 通用

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_STATE_DIR` | `<repo>/.ads` | 全局状态目录 |
| `ADS_STATE_DB_PATH` | `$ADS_STATE_DIR/state.db` | 全局 SQLite 路径 |
| `ALLOWED_DIRS` | 当前工作目录 | 允许访问/切换的目录，逗号分隔 |
| `SANDBOX_MODE` | `workspace-write` | `read-only`、`workspace-write`、`danger-full-access` |
| `ADS_SQLITE_BUSY_TIMEOUT_MS` | `5000` | workspace SQLite busy timeout |
| `ADS_LOG_FILE` / `ADS_LOG_DIR` | 未设置 | 日志输出位置 |
| `ADS_DEBUG` | 未设置 | 设为 `1` 启用 debug 日志 |

### Web

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_WEB_HOST` | `127.0.0.1` | Web 监听地址 |
| `ADS_WEB_PORT` | `8787` | Web 端口 |
| `ADS_WEB_MAX_CLIENTS` | `32` | WebSocket 最大连接数 |
| `ADS_WEB_WS_MAX_PAYLOAD_BYTES` | `16777216` | 单个 WebSocket 帧最大字节数（内存型 DoS 防护） |
| `ADS_WEB_ALLOWED_ORIGINS` | 同源/本机逻辑 | 允许的 Origin |
| `ADS_WEB_SESSION_TTL_SECONDS` | `604800` | 登录 cookie TTL |
| `ADS_WEB_SESSION_PEPPER` | 空 | session token hash pepper |
| `ADS_WEB_COOKIE_SECURE` | `auto` | Cookie Secure 策略 |
| `ADS_WEB_LOGIN_MAX_ATTEMPTS` | `5` | 登录失败锁定阈值（按用户名+IP 计数） |
| `ADS_WEB_LOGIN_LOCKOUT_MS` | `300000` | 登录锁定基础时长（重复触发指数退避） |
| `ADS_WEB_SESSION_SLIDING` | `false` | 是否滑动刷新 session |
| `ADS_WEB_SESSION_TIMEOUT_HOURS` | `24` | Web Agent 会话空闲超时 |
| `ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES` | `5` | 会话清理间隔 |
| `TASK_QUEUE_ENABLED` | `true` | 是否启用任务队列 |
| `TASK_QUEUE_AUTO_START` | `false` | Web 启动后是否自动运行队列 |
| `TASK_QUEUE_DEFAULT_MODEL` | 未设置 | 队列任务默认模型覆盖 |

### Agent

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_CODEX_BIN` | `codex` | Codex CLI 路径 |
| `ADS_CLAUDE_ENABLED` | 启用 | 设为 `0` 禁用 Claude |
| `ADS_CLAUDE_BIN` | `claude` | Claude CLI 路径 |
| `ADS_CLAUDE_MODEL` | 未设置 | Claude 模型 |
| `ADS_GEMINI_ENABLED` | 启用 | 设为 `0` 禁用 Gemini |
| `ADS_GEMINI_BIN` | `gemini` | Gemini CLI 路径 |
| `ADS_GEMINI_MODEL` | 未设置 | Gemini 模型 |
| `ADS_AGENT_PROBE_TIMEOUT_MS` | `5000` | CLI 可用性探测超时 |
| `ADS_AGENT_RUN_TIMEOUT_MS` | `1800000` | Agent 单次运行硬超时（0 关闭；到期 SIGTERM→SIGKILL） |
| `ADS_TASK_MAX_PARALLEL` | `3` | 协调器并行委派数 |
| `ADS_TASK_TIMEOUT_MS` | `120000` | 委派任务超时 |
| `ADS_TASK_MAX_ATTEMPTS` | `2` | 委派任务尝试次数 |
| `ADS_COORDINATOR_ENABLED` | 未设置 | 启用任务协调器 |

### 系统提示、记忆与技能

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_REINJECTION_ENABLED` | `true` | 是否再注入系统提示 |
| `ADS_REINJECTION_TURNS` | `10` | instructions 再注入轮次 |
| `ADS_RULES_REINJECTION_TURNS` | `1` | rules 再注入轮次 |
| `ADS_MEMORY_INJECTION_ENABLED` | `true` | 是否注入记忆 |
| `ADS_MEMORY_MAX_TOKENS` | `1024` | memory token 上限 |
| `ADS_SOUL_MAX_TOKENS` | `512` | soul token 上限 |
| `ADS_SKILLS_AUTOLOAD` | `true` | 自动加载匹配技能 |
| `ADS_SKILLS_AUTOSAVE` | `true` | 自动保存技能草稿 |
| `ADS_ENABLE_WORKSPACE_SKILLS` | 未设置 | 是否启用 workspace skills |

### Scheduler

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADS_SCHEDULER_ENABLED` | `true` | 是否启用调度器 |
| `ADS_SCHEDULER_TICK_MS` | `5000` | 调度轮询间隔 |
| `ADS_SCHEDULER_RUNNER_CONCURRENCY` | `1` | 定时任务并发数 |
| `ADS_SCHEDULER_RUNNER_TIMEOUT_SECS` | `1800` | 单次运行超时 |
| `ADS_SCHEDULER_MODEL` | `TASK_QUEUE_DEFAULT_MODEL` | 定时任务默认模型 |
| `ADS_SCHEDULER_COMPILE_MODEL` | 未设置 | 计划编译模型 |

## Telegram Bot

### 启动

```bash
export TELEGRAM_BOT_TOKEN='your-bot-token'
export TELEGRAM_ALLOWED_USER_ID='your-telegram-user-id'
node dist/server/cli.js telegram
# 或
ads telegram
# 或 legacy alias
ads-telegram
```

`TELEGRAM_ALLOWED_USERS` 仍作为 legacy alias 存在，但当前只支持单个用户 ID。Web 的任务完成通知也会复用 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_ALLOWED_USER_ID`。

### Telegram 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 必填 | Bot token |
| `TELEGRAM_ALLOWED_USER_ID` | 必填 | 单个允许用户 ID |
| `TELEGRAM_MAX_RPM` | `10` | 每分钟请求限制 |
| `TELEGRAM_SESSION_TIMEOUT` | `24h` | Telegram Agent 会话超时（毫秒） |
| `TELEGRAM_STREAM_UPDATE_INTERVAL` | `1500` | 流式消息更新间隔 |
| `TELEGRAM_MODEL` | 未设置 | Telegram 默认模型 |
| `TELEGRAM_PROXY_URL` | 未设置 | Telegram HTTP/HTTPS 代理 |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | 是否静默通知 |
| `ADS_TG_ALLOW_SUICIDE_RESTART` | `false` | 非 pm2 场景允许自重启 |
| `ADS_PM2_APP_WEB` | 未设置 | pm2 Web app 名称，用于 `restart web` |
| `ADS_TELEGRAM_NOTIFY_TIMEZONE` | `Asia/Shanghai` | Web 任务通知时区 |

### Telegram 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎信息 |
| `/help` | 命令帮助 |
| `/status` | 系统状态 |
| `/reset` | 重置会话，开始新对话 |
| `/resume` | 当前精简版不支持恢复，会提示使用 `/reset` |
| `/esc` | 中断当前任务，Agent 进程保留 |
| `/mark [on\|off]` | 将后续对话记录到当天 note |
| `/pref [list\|add\|del]` | 管理长期偏好 |
| `/pwd` | 查看当前工作目录 |
| `/cd <path>` | 在 `ALLOWED_DIRS` 约束内切换工作目录 |

## Web 使用要点

- 首次登录前必须先运行 `web:init-admin`。
- Web 支持项目列表；内置 `default` project 绑定到 `ALLOWED_DIRS` 的第一个目录。
- Planner lane 默认只读，Worker lane 默认 `danger-full-access`；实际可访问目录仍受 `ALLOWED_DIRS` 和沙箱策略约束。
- Web 聊天支持 `/pwd`、`/cd <path>` 和 Agent 切换；旧的用户可见 `/ads.*` 规划命令已停用，规格草稿/任务审批由 UI 和 Planner 流程驱动。
- Goal Mode 需要 Codex app-server 能正常启动；普通任务默认走 Codex CLI。

## 模板与运行时资产

构建时 `scripts/copy-runtime-assets.js` 会把 `templates/` 复制到 `dist/templates`，并把 `.agent/skills` 复制到 `dist/.agent/skills`（如果存在）。当前必需模板：

- `instructions.md`
- `rules.md`
- `supervisor.md`
- `requirement.md`
- `design.md`
- `implementation.md`
- `task.md`

`templates/skills/` 是允许的模板子目录；`templates/compaction.md` 也会作为普通文件复制。

## 数据与目录布局

默认状态目录为项目根目录下 `.ads/`：

```text
.ads/
├── state.db                         # 全局状态：Web 用户、会话、历史、模型配置、draft 等
├── run/web.pid                      # Web 进程 pid 文件
└── workspaces/<workspace-id>/
    ├── ads.db                       # workspace 任务、附件、队列、会话等数据
    ├── workspace.json
    └── ...
```

历史版本的 workspace `.ads/` 会被尽力迁移到集中状态目录。仓库根目录存在的 `ads.db` 是 ADS 自身工作区的 legacy/兼容数据库路径。

## 项目结构

```text
ads/
├── server/
│   ├── agents/        # Codex / Claude / Gemini 适配器、协作调度、健康探测
│   ├── bootstrap/     # bootstrap 执行、worktree、review gate
│   ├── codex/         # Codex app-server 协议与 RPC 客户端
│   ├── context/       # 上下文压缩与 token 估算
│   ├── memory/        # soul / preference / markdown memory
│   ├── scheduler/     # 定时任务编译与运行时
│   ├── skills/        # skill 加载、创建和内置工具
│   ├── state/         # 全局 SQLite schema/migrations/store
│   ├── storage/       # workspace SQLite schema/migrations/store
│   ├── systemPrompt/  # instructions/rules/supervisor 注入
│   ├── tasks/         # 任务模型、队列、执行器、store
│   ├── telegram/      # Telegram Bot、命令、附件/语音处理
│   ├── web/           # Web server、API、WebSocket、auth、task queue
│   └── workspace/     # workspace 检测、路径和模板同步
├── client/            # Vue 3 + Vite Web UI
├── tests/             # Node test runner 后端测试
├── templates/         # runtime prompt/spec 模板
├── scripts/           # 构建、bundle、类型生成脚本
└── docs/              # pm2、spec、ADR 等项目文档
```

## 测试与验证

```bash
npx tsc --noEmit
npm run lint
npm test
npm run test:web
npm run build
```

## 安全提示

- 不要提交 `.env` 或 `.env.local`。
- Web 必须初始化管理员账号，建议使用强密码并配置反向代理 TLS。
- 生产/公网部署请显式设置 `ADS_WEB_ALLOWED_ORIGINS`、`ADS_WEB_SESSION_PEPPER`、`ADS_WEB_COOKIE_SECURE=true`。
- Telegram 必须配置 `TELEGRAM_ALLOWED_USER_ID`；不要使用多用户共享 Bot token。
- `ALLOWED_DIRS` 应尽量收窄到可信工作区；谨慎使用 `SANDBOX_MODE=danger-full-access`。
- 泄露的 Telegram token、Agent API key 或 CLI 凭据应立即撤销/轮换。

## License

MIT License. See [LICENSE](LICENSE).
