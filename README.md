# ADS MCP Server (Node.js)

## 📚 Documentation

### Telegram Bot

📱 **[Telegram Bot Documentation](./docs/telegram/)** - Complete guide for remote bot control

Quick links:
- [Quick Start (5 min)](./docs/telegram/QUICKSTART.md) - Get started in 5 minutes
- [Full Guide](./docs/telegram/FULL_GUIDE.md) - Complete documentation
- [Deployment Guide](./docs/telegram/DEPLOYMENT.md) - Production deployment

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

## Codex slash commands

Codex exposes slash commands via local prompt files (mirroring the approach used in the Python ADS repo and spec-kit). To let `/ads.status`, `/ads.new`, and friends call this MCP server instead of shelling out to a CLI, run:

```bash
npm run install:codex-prompts
```

The script writes Markdown prompts to `~/.codex/prompts/*.md`. Each prompt instructs Codex to call the corresponding MCP tool (`ads.status`, `ads.new`, `ads.branch`, …) with parsed arguments. Restart Codex after installing so the new commands show up in the picker.
