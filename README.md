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

# (Optional) expose the CLI locally without publishing
npm link
```
### Basic Usage

1. **Initialize a workspace**:
   ```bash
   /ads.init
   ```
   - 可选 `--name=<workspace>` 指定工作区名称（默认取当前目录名）。
   - 会创建 `.ads/workspace.json`、`.ads/ads.db` 占位符、`.ads/templates/*`、`.ads/rules.md`，并确保 `docs/spec/` 目录存在。重复执行是幂等的。

2. **Create a new workflow**:
   ```bash
   /ads.new "Implement user authentication"
   ```

3. **Check status**:
   ```bash
   /ads.status
   ```

### Common ADS commands
- `/ads.init [--name=<workspace>]` - 初始化当前目录工作区
- `/ads.status` - 查看当前工作流状态
- `/ads.new <title>` - 创建新工作流（默认 unified 模板）
- `/ads.checkout <workflow>` - 切换工作流
- `/ads.commit <step>` - 定稿步骤并推进到下一步
- `/ads.branch [-d|--delete-context <id>] [--delete <id>]` - 列出或删除工作流（含上下文/数据）
- `/ads.log [limit] [workflow]` - 查看最近的 workflow commit 日志
- `/ads.rules [category]` - 查看项目规则
- `/ads.workspace` / `/ads.sync` - 查看/同步工作区
- `/ads.review [--skip=<reason>] [--show] [--spec] [--commit[=<ref>]]` - 触发/查看 Review，可指定最新提交或当前 diff，默认仅基于代码 diff

## 📚 Documentation

Comprehensive documentation is being migrated into this repository. Until those guides land, use the following sources:

- `docs/spec/**` — canonical specifications describing features (requirements, design, implementation).
- `templates/` — the workspace templates synced into `.ads/templates/`, useful for understanding prompts and workflows.
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

- CLI、Web Console、Telegram Bot 会自动读取工作区根目录的 `.env`，并在存在时加载 `.env.local` 作为覆盖，无需手动 `source`。
- 建议将共享变量（如 `TELEGRAM_*`、`ADS_WEB_HOST`/`ADS_WEB_PORT`、`ALLOWED_DIRS`）写在 `.env`，机器专属配置放 `.env.local`。

### Runtime requirements

- Node.js 18 or newer (ESM + top-level await support).
- A writable ADS workspace (the server reads `.ads/ads.db`, `.ads/rules.md`, etc.).
- SQLite build headers for `better-sqlite3` (handled via `npm install`).

### Template Layout

ADS 依赖单一的 `templates/` 目录来初始化工作区（同时在构建时复制到 `dist/templates`）。目录内仅包含 6 个扁平文件：

- `instructions.md` – 系统提示与工作流指引
- `rules.md` – 默认工作区规则
- `requirement.md` – 需求文档模板
- `design.md` – 设计文档模板
- `implementation.md` – 实施/验证模板
- `workflow.yaml` – 工作流步骤定义

每次运行 CLI 时，`templates/` 的内容都会同步到 `.ads/templates/`，如需自定义模板只需编辑这些文件。

### System Prompt Reinjection

- 所有会话会自动注入 `templates/instructions.md` 与工作区 `.ads/rules.md`。
- 通过以下环境变量调节再注入：
  - `ADS_REINJECTION_ENABLED`（默认 `true`，设置为 `0`/`false` 禁用）
  - `ADS_REINJECTION_TURNS`（默认 `10`）
  - `ADS_RULES_REINJECTION_TURNS`（默认 `1`，即每轮重新注入 workspace 规则，可调大以降低频率）
  - `CLI_REINJECTION_*` / `TELEGRAM_REINJECTION_*` 可覆盖对应入口。

### Codex 配置

- 优先级：CLI 传参 `--base-url`/`--api-key` > 环境变量 `CODEX_BASE_URL`/`OPENAI_BASE_URL`、`CODEX_API_KEY`/`OPENAI_API_KEY` > `~/.codex/config.toml` 的 provider 配置 > `~/.codex/auth.json` 中的 API Key 或 `codex login` 生成的 `tokens`（access/refresh token）。
- 若只提供 API Key 而未指定 baseUrl，默认使用 `https://api.openai.com/v1`；仅使用 `codex login` 的设备令牌时可不填 baseUrl。
- 建议：使用 `codex login` 或设置 `CODEX_API_KEY`，避免在仓库中保存明文密钥。

### Claude Agent（实验性）

Claude 集成正在逐步落地，可通过以下环境变量启用实验特性：

- `ENABLE_CLAUDE_AGENT=1`：显式打开 Claude 适配器（默认关闭，可在 `.claude/config.json` 里设置 `enabled: true`）
- `CLAUDE_API_KEY`：Anthropic API Key（若未设置，依次回退查找 `ANTHROPIC_API_KEY` 或 `~/.claude/auth.json`）
- `CLAUDE_MODEL`：Claude 模型名称，默认 `claude-sonnet-4.5`
- `CLAUDE_WORKDIR`：Claude Agent Runner 的工作目录，默认 `/tmp/ads-claude-agent`
- `CLAUDE_TOOL_ALLOWLIST`：逗号分隔的工具白名单，占位用于后续阶段
- `CLAUDE_BASE_URL` / `ANTHROPIC_BASE_URL`：如采用自托管 Claude Code endpoint，可在此指定 API 基础地址

也支持从主目录读取配置（用于避免把密钥写进仓库）：

`~/.claude/config.json`（或 `settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`）：
```json
{
  "enabled": true,
  "api_key": "sk-ant-xxx",
  "model": "claude-sonnet-4.5",
  "workdir": "/tmp/ads-claude-agent",
  "tool_allowlist": ["bash", "file.edit"]
}
```

（可选）在 `~/.claude/auth.json` 中保存 `{"ANTHROPIC_API_KEY": "..."}` 以与 `config.json` 分离密钥。

### Gemini Agent（实验性）

Gemini 适配器基于官方 SDK `@google/genai`，并使用 Gemini 的 Function Calling 调用 ADS 内置工具（`exec` / `read` / `write` / `apply_patch` / `search`）。因此当 Gemini 作为主代理时，不需要、也不应输出 `<<<tool.*>>>` 文本工具块。

环境变量（优先级最高）：

- `ENABLE_GEMINI_AGENT=1`：显式打开 Gemini 适配器（默认关闭；若检测到可用凭据也会自动启用）
- `GEMINI_API_KEY`：Google AI Studio API Key（也支持 `GOOGLE_API_KEY`）
- `GEMINI_MODEL`：Gemini 模型名称，默认 `gemini-2.0-flash`
- （可选）`GEMINI_BASE_URL`：自定义 API Base URL（如代理/自托管）
- （可选）`GEMINI_API_VERSION`：如 `v1beta` / `v1`
- （可选）`GEMINI_ACCESS_TOKEN`：OAuth Access Token（通常用于 Vertex AI 或受控环境）

主目录配置（默认 `~/.gemini`，也可用 `GEMINI_CONFIG_DIR` 覆盖目录）：

- `.env` / `.env.local`（也兼容旧文件名 `.ven` / `.ven.local`）
- `config.json`（结构化配置）
- `auth.json`（密钥/凭据，优先级最低；若为 `authorized_user` JSON 会作为 `GOOGLE_APPLICATION_CREDENTIALS` 使用）

Vertex AI（可选）：

- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT=your-project-id`
- `GOOGLE_CLOUD_LOCATION=us-central1`
- （可选）`GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json`

配置解析逻辑位于 `src/agents/config.ts`，若检测到任一 Claude/Gemini 可用凭据（环境变量或主目录配置文件）则默认启用对应适配器；CLI/Web/Telegram 均支持 `/agent` 命令在 Codex/Claude/Gemini 之间切换。

### 协作代理（主代理自动调度/委派）

- 默认主代理为 Codex（主管/执行者）。当 Codex 判断需要前端/UI/文案/第二意见等协作时，会自动触发 Claude/Gemini 协作回合，并在下一轮整合、落地与验收后再给你最终答复。
- 你无需手写 `<<<agent.*>>>` 指令块；直接用自然语言描述需求即可。若想强制让 Codex 调用某个协作代理，可在需求里明确写“请让 Claude/Gemini 帮我做 X，并给出补丁/差异说明”。
- 当前主代理为任意 Agent 时，只要输出包含 `<<<agent.<id>>>` 指令块，就会触发协作调度；系统会执行并把协作结果回注给主代理继续整合。
- （可选）启用工具开关后，Gemini 会通过 Function Calling 自动调用工具；`<<<tool.*>>>` 文本工具块仅作为兼容协议保留（主要用于自定义/调试代理）。工具输出会自动回注给当前主代理继续，多轮直到无新工具块或达到上限：
  - `ENABLE_AGENT_EXEC_TOOL=1`：允许 `<<<tool.exec ...>>>` 执行本机命令（可选用 `AGENT_EXEC_TOOL_ALLOWLIST` 限制命令；设置为 `*` 表示不限制）
  - `ENABLE_AGENT_FILE_TOOLS=1`：允许 `<<<tool.read ...>>>` / `<<<tool.write ...>>>` 读写文件（受 `ALLOWED_DIRS` 目录白名单限制）
  - `ENABLE_AGENT_APPLY_PATCH=1`：允许 `<<<tool.apply_patch ...>>>` 应用 unified diff（需要 `git`；受 `ALLOWED_DIRS` 限制）
  - `ADS_AGENT_MAX_TOOL_ROUNDS=0`：工具闭环的最大回合数（0=不限制）
  ```
  <<<tool.exec
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
- 浏览器访问对应地址即可与 CLI 相同的代理交互，环境变量来自根目录 `.env`（自动加载 `.env` + `.env.local`）。
- 聊天日志支持本地缓存（按 token 隔离，约 100 条/200KB，TTL 1 天），顶部“清空历史”按钮可同时清理日志与缓存；会话标签支持重命名并按 token 记住工作目录，重连/切换时自动恢复；流式回复的“正在输入”占位符按会话隔离。

### 📱 Telegram Bot 远程编程

通过 Telegram Bot，你可以在任意地点、任意设备上远程控制开发工作流：

**启动 Bot**：
```bash
# 设置环境变量
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_ALLOWED_USERS="your-telegram-user-id"

# 启动 Bot（构建后，复用根目录 .env）
npm run services -- start telegram
# 或使用 CLI 入口
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
| `/ads` | ADS 工作流命令入口 |
| `/ads.new <title>` | 创建新工作流 |
| `/ads.status` | 查看当前工作流状态 |
| `/ads.commit <step>` | 定稿指定步骤 |
| `/ads.review` | 触发代码审查 |
| `/esc` | 中断当前任务（Agent 保持运行） |
| `/reset` | 重置会话，开始新对话 |
| `/mark [on\|off]` | 记录对话到 `YYYY-MM-DD-note.md`（可省略参数切换状态） |
| `/agent [name]` | 查看或切换代理（Codex/Claude/Gemini） |
| `/cd <path>` | 切换工作目录 |

**特性**：
- 💬 直接发送消息与 AI 对话，支持多轮交互
- 🖼️ 发送图片让 AI 分析（截图、设计稿等）
- 📎 发送文件让 AI 处理
- 🔄 会话持久化，断线后可 `/resume` 恢复
- 📝 `/mark` 可将后续对话记录到当天 note，便于整理灵感
- ⚡ `/esc` 可随时中断当前任务，立即执行新指令；Web 端提供停止按钮（执行中可用）

### 🔍 Tavily Search Tool

ADS 支持通过 Tavily MCP 为 Codex 提供联网搜索能力。

**快速配置（推荐）**：

```bash
# 设置 API 密钥
export TAVILY_API_KEY="tvly-xxx"

# 自动配置 Codex MCP（使用本地 NPX 方式）
npx ts-node src/tools/search/setupCodexMcp.ts setup

# 或使用 Tavily 远程 MCP 服务器（无需本地安装）
npx ts-node src/tools/search/setupCodexMcp.ts setup --remote

# 检查配置状态
npx ts-node src/tools/search/setupCodexMcp.ts status
```

配置后 Codex 会自动获得 `tavily_search` 和 `tavily_extract` 工具，无需在 prompt 中手动说明。

**手动配置**（`~/.codex/config.toml`）：

```toml
# 方式1：本地 NPX（推荐，可离线缓存）
[mcp_servers.tavily]
command = "npx"
args = ["-y", "tavily-mcp@latest"]
tool_timeout_sec = 30

[mcp_servers.tavily.env]
TAVILY_API_KEY = "tvly-xxx"

# 方式2：远程 HTTP（无需本地 Node.js）
[mcp_servers.tavily]
url = "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-xxx"
tool_timeout_sec = 30
```

**为什么旧的 `<<<tool.search>>>` 方式不工作？**

之前使用自定义文本标记协议让模型调用搜索，但：
1. 这不是原生的 Function Calling，模型不认识
2. 模型会说"我无法联网"因为它知道自己通常没有这个能力

正确的做法是通过 Codex 的 MCP 配置注册工具，这样模型在 API 层面就能看到并调用这些工具。

**其他配置**：

- 环境变量：`TAVILY_API_KEYS`（逗号分隔）或 `TAVILY_API_KEY`
- 速率配置：`maxResults` 上限 10，`retries` 3，`rps` 3，`concurrency` 3，`timeoutMs` 30000
- 详见 `src/tools/search/config.ts`

### 🔍 Review 工作流

实施完成后，可触发自动化代码审查：

```bash
# 触发 Review（实施步骤定稿后）
/ads.review

# 查看 Review 报告
/ads.review show

# 跳过 Review（需提供原因）
/ads.review skip 紧急上线，用户确认跳过
```

**Review 流程**：
1. 自动收集 bundle（git diff、spec 文档、测试日志、依赖变更）
2. 启动独立 Reviewer Agent 执行检查
3. 生成结构化报告（verdict: approved/blocked + issues）
4. Review 期间工作流锁定，禁止其他修改

**Review 状态**：
- `pending` - 等待执行
- `running` - 正在审查
- `approved` - 审查通过 ✅
- `blocked` - 发现问题，需修复 ❌
- `skipped` - 用户跳过（已记录原因）

**规则**：
- 实施完成后**必须**执行 `/ads.review`，除非用户明确要求跳过
- Review 进行期间禁止执行写操作
- 跳过 Review 需提供原因并记录

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
- Configure `TELEGRAM_ALLOWED_USERS` and `ALLOWED_DIRS` appropriately
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
