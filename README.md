# ADS - AI Driven Specification

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

AI-driven specification-based development workflow automation with Telegram bot support. Built with Node.js/TypeScript.

## ✨ Features

- 📱 **Telegram Bot**: Remote control your development workflow via Telegram from anywhere
- 🌐 **Web Console**: Browser-based console with streaming responses and directory safeguards
- 🔄 **Workflow Automation**: Template-based workflow management and execution
- 💾 **SQLite Workspace**: Persistent graph-based project state tracking
- 🎯 **Context Management**: Intelligent context injection and reinjection
- 🔍 **Review Workflow**: Automated code review before delivery with AI agents
- 🔧 **Extensible**: Plugin-friendly architecture for custom tools and workflows

## 🚀 Quick Start

### Installation

```bash
# Clone the repository (replace YOUR_USERNAME if you forked it)
git clone https://github.com/YOUR_USERNAME/ads.git
cd ads

# Install dependencies and build once
npm install
npm run build
```
### Basic Usage

1. **Start the Web Console**:
   ```bash
   npm run web
   ```

2. **Describe your goal in chat** (slash commands are not supported).

3. **Review outputs**:
   - Specs live under `docs/spec/`.
   - Planner drafts and queued tasks are visible in the Web UI.

## 📚 Documentation

Comprehensive documentation is being migrated into this repository. Until those guides land, use the following sources:

- `docs/spec/**` — canonical specifications describing features (requirements, design, implementation).
- `templates/` — the workspace templates synced into centralized `.ads/workspaces/<workspaceId>/templates/`, useful for understanding prompts and workflows.
- Inline comments in `src/telegram/**` for Telegram bot behavior, including workspace initialization prompts.

Missing guides referenced elsewhere will be restored once the documentation migration completes.

---

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run in watch mode (rebuilds on change):
   ```bash
   npm run dev
   ```
3. Build once:
   ```bash
   npm run build
   ```
4. Start the compiled server:
   ```bash
   npm start
   ```

### Environment loading

- Web Console、Telegram Bot 会自动读取工作区根目录的 `.env`，并在存在时加载 `.env.local` 作为覆盖，无需手动 `source`。
- 建议将共享变量（如 `TELEGRAM_*`、`ADS_WEB_HOST`/`ADS_WEB_PORT`、`ALLOWED_DIRS`）写在 `.env`，机器专属配置放 `.env.local`。

### Runtime requirements

- Node.js 18 or newer (ESM + top-level await support).
- A writable ADS state directory (default `./.ads/`; workspace state lives under `.ads/workspaces/<workspaceId>/`).
- SQLite build headers for `better-sqlite3` (handled via `npm install`).

### Template Layout

ADS 依赖单一的 `templates/` 目录来初始化工作区（同时在构建时复制到 `dist/templates`）。目录内仅包含 6 个扁平文件：

- `instructions.md` – 系统提示与工作流指引
- `rules.md` – 默认工作区规则
- `requirement.md` – 需求文档模板
- `design.md` – 设计文档模板
- `implementation.md` – 实施/验证模板
- `workflow.yaml` – 工作流步骤定义

ADS 会在工作区初始化与 Web Console 启动/切换目录时同步 `templates/` 到 `.ads/workspaces/<workspaceId>/templates/`，如需自定义模板只需编辑这些文件。

### System Prompt Reinjection

- 所有会话会自动注入 `templates/instructions.md` 与工作区规则（集中式存储于 `.ads/workspaces/<workspaceId>/rules.md`）。
- 通过以下环境变量调节再注入：
  - `ADS_REINJECTION_ENABLED`（默认 `true`，设置为 `0`/`false` 禁用）
  - `ADS_REINJECTION_TURNS`（默认 `10`）
  - `ADS_RULES_REINJECTION_TURNS`（默认 `1`，即每轮重新注入 workspace 规则，可调大以降低频率）

### Codex 配置

- 优先级：环境变量 `CODEX_BASE_URL`/`OPENAI_BASE_URL`、`CODEX_API_KEY`/`OPENAI_API_KEY` > `${CODEX_HOME:-~/.codex}/config.toml` 的 provider 配置 > `${CODEX_HOME:-~/.codex}/auth.json` 中的 API Key 或 `codex login` 生成的 `tokens`（access/refresh token）。
- 若只提供 API Key 而未指定 baseUrl，默认使用 `https://api.openai.com/v1`；仅使用 `codex login` 的设备令牌时可不填 baseUrl。
- 建议：使用 `codex login` 或设置 `CODEX_API_KEY`，避免在仓库中保存明文密钥。

### Claude Agent（实验性）

Claude 集成通过 `claude` CLI（Claude Code）落地，可通过以下环境变量启用实验特性：

- `ADS_CLAUDE_ENABLED=0`：禁用 Claude CLI 适配器（默认启用）
- `ADS_CLAUDE_BIN`：Claude CLI binary（默认 `claude`）
- `ADS_CLAUDE_MODEL`：Claude 模型名称（透传给 CLI）

鉴权/配置由 Claude CLI 自身负责（例如 `claude login` / 主目录配置），ADS 不再通过 SDK 直接读取/管理密钥。

`~/.claude/config.json` 示例（具体字段以 CLI 为准）：
```json
{
  "enabled": true,
  "model": "claude-sonnet-4.5",
  "workdir": "/tmp/ads-claude-agent",
  "tool_allowlist": ["bash", "file.edit"]
}
```

### Gemini Agent（实验性）

Gemini 集成通过 `gemini` CLI 落地（JSONL stream），不依赖 Google SDK；工具调用由 CLI 自身处理。

环境变量（优先级最高）：

- `ADS_GEMINI_ENABLED=0`：禁用 Gemini CLI 适配器（默认启用）
- `ADS_GEMINI_BIN`：Gemini CLI binary（默认 `gemini`）
- `ADS_GEMINI_MODEL`：Gemini 模型名称（透传给 CLI）

鉴权/配置由 Gemini CLI 自身负责（例如 `gemini auth` / 主目录配置），ADS 不再通过 SDK 直接读取/管理密钥。

适配器启用/禁用开关由 `src/telegram/utils/sessionManager.ts` 读取环境变量（例如 `ADS_CLAUDE_ENABLED`/`ADS_GEMINI_ENABLED`）；Web Console 支持 `/agent` 命令切换激活的 Agent。

### 协作代理（主代理自动调度/委派）

- 默认主代理为 Codex（主管/执行者）。当 Codex 判断需要前端/UI/文案/第二意见等协作时，会自动触发 Claude/Gemini 协作回合，并在下一轮整合、落地与验收后再给你最终答复。
- 你无需手写 `<<<agent.*>>>` 指令块；直接用自然语言描述需求即可。若想强制让 Codex 调用某个协作代理，可在需求里明确写“请让 Claude/Gemini 帮我做 X，并给出补丁/差异说明”。
- 当前主代理为任意 Agent 时，只要输出包含 `<<<agent.<id>>>` 指令块，就会触发协作调度；系统会执行并把协作结果回注给主代理继续整合。
- ADS 不再解析/执行 `<<<tool.*>>>` 文本工具块；工具能力由各 CLI 自身提供（例如 `codex exec`、`claude --permission-mode ...`、`gemini --approval-mode ...`）。
  npm test
  >>>
  ```
- （高级）如需显式触发协作代理，可要求 Codex 在输出中生成指令块（系统会执行，但最终回复会自动剔除指令块，避免泄露中间过程）：
  ```
  <<<agent.claude
  需要 Claude 协助的任务说明（提供上下文、约束、期望输出）
  >>>
  ```
  ```
  <<<agent.gemini
  需要 Gemini 协助的任务说明（提供上下文、约束、期望输出）
  >>>
  ```

### 🌐 Web Console（实验性）

- 使用统一的 services 脚本启动（构建后）：`npm run services -- start web`
- 默认监听 `0.0.0.0:8787`（可用 `ADS_WEB_HOST`、`ADS_WEB_PORT` 调整），目录白名单由 `ALLOWED_DIRS` 控制（Web/Telegram 共用）。
- 浏览器访问对应地址即可与 Telegram 相同的代理交互，环境变量来自根目录 `.env`（自动加载 `.env` + `.env.local`）。
- （可选）任务完成 Telegram 通知：复用 `TELEGRAM_BOT_TOKEN`，并使用 `TELEGRAM_ALLOWED_USER_ID` 作为通知 `chat_id`（单用户约束；`TELEGRAM_ALLOWED_USERS` 为 legacy alias）；可用 `ADS_TELEGRAM_NOTIFY_TIMEZONE` 设置通知时间戳时区（默认 `Asia/Shanghai`）。
- 聊天日志支持本地缓存（按 token 隔离，约 100 条/200KB，TTL 1 天），顶部“清空历史”按钮可同时清理日志与缓存；会话标签支持重命名并按 token 记住工作目录，重连/切换时自动恢复；流式回复的“正在输入”占位符按会话隔离。
- Plan 以侧边栏面板呈现，不再作为聊天消息写入历史（避免刷屏）；同时会过滤掉类似 `Idiomatic English:` 的翻译前缀，保持历史与工具输出更干净。

### 📱 Telegram Bot 远程编程

通过 Telegram Bot，你可以在任意地点、任意设备上远程控制开发工作流：

**启动 Bot**：
```bash
# 设置环境变量
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_ALLOWED_USER_ID="your-telegram-user-id"

# 启动 Bot（构建后，复用根目录 .env）
npm run services -- start telegram
# Or run the telegram launcher (after build)
ads-telegram start

# 停止 / 状态
npm run services -- stop telegram
npm run services -- status
```

> 推荐：把上述配置写入根目录的 `.env`，Telegram 与 Web Console 会共用这一份环境变量。目录白名单使用统一的 `ALLOWED_DIRS`。
> 旧的 `telegram-bot.sh` 已移除，统一通过 `npm run services -- <start|stop|status>` 管理服务。

**常用命令**：
| 命令 | 说明 |
| ---- | ---- |
| `/start` | 欢迎信息 |
| `/help` | 命令帮助 |
| `/status` | 系统状态 |
| `/esc` | 中断当前任务（Agent 保持运行） |
| `/reset` | 重置会话，开始新对话 |
| `/mark [on\|off]` | 记录对话到 `YYYY-MM-DD-note.md`（可省略参数切换状态） |
| `/pref [list|add|del]` | 管理偏好设置（长期记忆） |
| `/draft <text>` | 创建任务草稿（需确认后入队） |
| `/pwd` | 当前工作目录 |
| `/cd <path>` | 切换工作目录 |

**特性**：
- 💬 直接发送消息与 AI 对话，支持多轮交互
- 🖼️ 发送图片让 AI 分析（截图、设计稿等）
- 📎 发送文件让 AI 处理
- 📝 `/mark` 可将后续对话记录到当天 note，便于整理灵感
- ⚡ `/esc` 可随时中断当前任务，立即执行新指令；Web 端提供停止按钮（执行中可用）

### 🔍 Tavily Research (Skill)

ADS 不再内置 Tavily 的 runtime 集成（已移除 `src/tools/search/**`）。联网搜索与 URL 抓取仅通过 skill 脚本提供：

```bash
export TAVILY_API_KEY="your_tavily_api_key"

# Web search (JSON output)
node .agent/skills/tavily-research/scripts/tavily-cli.cjs search --query "..." --maxResults 5

# URL fetch/extract (JSON output)
node .agent/skills/tavily-research/scripts/tavily-cli.cjs fetch --url "https://..." --extractDepth advanced --format markdown
```

### 🔍 Review

ADS can run an automated code review step before delivery (no user-facing slash commands). See `docs/spec/**` and `docs/adr/**` for details.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Setting up the development environment
- Coding standards and best practices
- Pull request process
- Testing guidelines

## 🔒 Security

Security is important to us. If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) for responsible disclosure.

### Key Security Practices

- Never commit `.env` or `.env.*` files to version control
- Use `.env.example` as a template
- Set proper file permissions for sensitive files (`chmod 600 .env`)
- Configure `TELEGRAM_ALLOWED_USER_ID` (legacy: `TELEGRAM_ALLOWED_USERS`) and `ALLOWED_DIRS` appropriately
- If your environment requires a proxy, set `TELEGRAM_PROXY_URL` (e.g. `http://127.0.0.1:7897`) instead of hardcoding it in code
- Revoke leaked tokens immediately via [@BotFather](https://t.me/BotFather)

See [SECURITY.md](SECURITY.md) for complete security guidelines.

## 📦 Project Structure

```
ads/
├── src/              # Source code
│   ├── tools/        # ADS tool implementations
│   ├── graph/        # Graph persistence & workflow logic
│   ├── workspace/    # Workspace management
│   ├── telegram/     # Telegram bot implementation
│   └── templates/    # Template rendering
├── tests/            # Test files
├── templates/        # Workspace templates
├── docs/             # Documentation
└── scripts/          # Build and utility scripts
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [OpenAI Codex SDK](https://github.com/openai/codex-sdk)
- Telegram bot powered by [grammY](https://grammy.dev)
- Database powered by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

## 📮 Support

- 📖 [Documentation](./docs/)
- 🐛 [Report Issues](https://github.com/Andy963/ads/issues)
- 💬 [Discussions](https://github.com/Andy963/ads/discussions)

---

**Note**: This is an experimental preview. Treat it as beta software while edge cases are validated.
