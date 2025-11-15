# ADS - AI-Powered Development System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

AI-powered development workflow automation system with MCP (Model Context Protocol) server implementation and Telegram bot support. Built with Node.js/TypeScript.

## ✨ Features

- 🤖 **MCP Server**: Full-featured MCP server for AI assistants (Claude, etc.)
- 📱 **Telegram Bot**: Remote control your development workflow via Telegram
- 🔄 **Workflow Automation**: Template-based workflow management and execution
- 💾 **SQLite Workspace**: Persistent graph-based project state tracking
- 🎯 **Context Management**: Intelligent context injection and reinjection
- 🔧 **Extensible**: Plugin-friendly architecture for custom tools and workflows

## 🚀 Quick Start

### Installation

```bash
# Install globally via npm
npm install -g ads

# Or use locally
npm install
npm run build
```

### Basic Usage

1. **Initialize a workspace**:
   ```bash
   ads init
   ```

2. **Create a new workflow**:
   ```bash
   ads new "Implement user authentication"
   ```

3. **Check status**:
   ```bash
   ads status
   ```

### Using with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ads": {
      "command": "node",
      "args": ["/path/to/ads/dist/src/ads.js", "--transport", "stdio"]
    }
  }
}
```

## 📚 Documentation

### Telegram Bot

📱 **[Telegram Bot Documentation](./docs/telegram/)** - Complete guide for remote bot control

Quick links:
- [Quick Start (5 min)](./docs/telegram/QUICKSTART.md) - Get started in 5 minutes
- [Full Guide](./docs/telegram/FULL_GUIDE.md) - Complete documentation
- [Deployment Guide](./docs/telegram/DEPLOYMENT.md) - Production deployment

> ℹ️ 使用 `/cd <path>` 切换目录时，如果目标目录缺少 `.ads/workspace.json` 或模板文件，Bot 会提示先运行 `ads init`，但仍会完成切换以便你在该目录执行初始化。

### General

- [Usage Guide](./docs/USAGE_GUIDE.md) - How to use ADS
- [Codex Integration](./docs/CODEX.md) - Codex SDK integration

---

This directory contains an experimental Node.js/TypeScript implementation of the ADS MCP server. It mirrors the capabilities of the existing Python service while offering a more convenient distribution path (e.g., via `npx`) once the project is production-ready.

> ⚠️ **Preview status**: this implementation re-creates the ADS MCP toolchain purely in Node.js. The server talks directly to the ADS SQLite workspace, reimplements workflow/context logic, and writes specs to disk. Expect functional parity with the Python version, but treat it as beta while edge-cases are validated.

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

### MCP transport

Currently the CLI only exposes the stdio transport:

```bash
npm start -- --transport stdio
```

The executable produced in `dist/server.js` is shebanged, so the project can later be packaged for `npx` consumption (`npx ads-mcp-server --transport stdio` once published).

The Node entrypoint lives at `src/server.ts`. It registers each MCP tool with its Zod schema and delegates to the TypeScript implementations under `src/tools`. Graph persistence, workflow automation, and template rendering are handled by modules in `src/graph`, `src/workspace`, and `src/templates`.

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
  - `ADS_REINJECTION_TURNS`（默认 `15`）
  - `CLI_REINJECTION_*` / `TELEGRAM_REINJECTION_*` 可覆盖对应入口。

## Codex slash commands

Codex exposes slash commands via local prompt files (mirroring the approach used in the Python ADS repo and spec-kit). To let `/ads.status`, `/ads.new`, and friends call this MCP server instead of shelling out to a CLI, run:

```bash
npm run install:codex-prompts
```

The script writes Markdown prompts to `~/.codex/prompts/*.md`. Each prompt instructs Codex to call the corresponding MCP tool (`ads.status`, `ads.new`, `ads.branch`, …) with parsed arguments. Restart Codex after installing so the new commands show up in the picker.

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
- Revoke leaked tokens immediately via [@BotFather](https://t.me/BotFather)

See [SECURITY.md](SECURITY.md) for complete security guidelines.

## 📦 Project Structure

```
ads/
├── src/              # Source code
│   ├── tools/        # MCP tool implementations
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
- 🐛 [Report Issues](https://github.com/YOUR_USERNAME/ads/issues)
- 💬 [Discussions](https://github.com/YOUR_USERNAME/ads/discussions)

---

**Note**: This is an experimental preview. While it aims for functional parity with the Python ADS implementation, treat it as beta software while edge cases are validated.
