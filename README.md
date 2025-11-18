# ADS - AI Driven Specification

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

AI-driven specification-based development workflow automation with Telegram bot support. Built with Node.js/TypeScript.

## ✨ Features

- 📱 **Telegram Bot**: Remote control your development workflow via Telegram
- 🔄 **Workflow Automation**: Template-based workflow management and execution
- 💾 **SQLite Workspace**: Persistent graph-based project state tracking
- 🎯 **Context Management**: Intelligent context injection and reinjection
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

2. **Create a new workflow**:
   ```bash
   /ads.new "Implement user authentication"
   ```

3. **Check status**:
   ```bash
   /ads.status
   ```

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
  - `CLI_REINJECTION_*` / `TELEGRAM_REINJECTION_*` 可覆盖对应入口。

### Claude Agent（实验性）

Claude 集成正在逐步落地，可通过以下环境变量启用实验特性：

- `ENABLE_CLAUDE_AGENT=1`：显式打开 Claude 适配器（默认关闭，可在 `.claude/config.json` 里设置 `enabled: true`）
- `CLAUDE_API_KEY`：Anthropic API Key（若未设置，依次回退查找 `ANTHROPIC_API_KEY` 或 `~/.claude/auth.json`）
- `CLAUDE_MODEL`：Claude 模型名称，默认 `claude-sonnet-4.5`
- `CLAUDE_WORKDIR`：Claude Agent Runner 的工作目录，默认 `/tmp/ads-claude-agent`
- `CLAUDE_TOOL_ALLOWLIST`：逗号分隔的工具白名单，占位用于后续阶段
- `ENABLE_GEMINI_AGENT`：预留开关，暂不生效

也可以像 Codex 一样在主目录放置配置文件：

`~/.claude/config.json`（或 `settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`）
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

配置解析逻辑位于 `src/agents/config.ts`，若检测到任一 Claude API Key（环境变量、`~/.claude/{config,auth,settings}.json`）则默认启用 Claude，CLI 与 Telegram Bot 支持 `/agent` 命令在 Codex 与 Claude 之间切换。

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
- Set proper file permissions for sensitive files (`chmod 600 .env.telegram`)
- Configure `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_ALLOWED_DIRS` appropriately
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
