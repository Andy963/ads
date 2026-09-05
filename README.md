# ADS (Agent Dispatch & Orchestration System)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

ADS 是一个面向 AI 编程工作流的本地 Web Console 与智能任务编排中枢。它以项目工作区为核心，围绕 Advisor（方案规划）/ Worker（代码执行）/ Task（任务看板与队列）构建了一体化的 AI 开发工作流，并通过 Codex App-Server 统一接入多 Provider 模型和可选的独立 Channel Connector。

---

## 核心特性

- **现代 Web Console**：基于 Vue 3 + Vite 构建的响应式控制台，支持移动端抽屉导航与桌面端全功能布局。
- **三 Tab 协作工作流**：
  - **Task (任务看板)**：可视化任务排队、执行、重试、错误追踪、开发/审核/返工分类及 Task Bundle 任务草稿审批。
  - **Advisor (规划 Lane)**：专属架构方案研讨；任务草稿可直接引用 GitHub Issue/PR 或使用自包含 prompt，不要求本地 issue/spec 文档。
  - **Worker (执行 Lane)**：有本地快照时读取批准时固定的 issue/spec 内容，否则直接依据任务 prompt 与 GitHub 引用执行，实时输出紧凑预览。
- **统一多 Provider 模型支持**：所有模型均通过 **Codex App-Server** 路由（包括 Anthropic Claude、Google Gemini 与 DeepSeek），支持模型可视化启用/停用与即时配置。
- **确定性安全拦截**：在命令执行边界保护 ADS 自身进程和 SQLite 数据库文件，不依赖模型提示或可变数据库规则。
- **Codex 标准技能体系**：全局技能原生对齐 `$CODEX_HOME/skills`（默认 `~/.codex/skills`）；支持对话中 `<skill_save>` 自动沉淀与存量遗留技能无损原子迁移，与 native Codex CLI 完全互通。
- **原生会话恢复 (Session Resume)**：零 Token 冗余恢复底层 CLI 真实历史上下文，断线重连自动增量同步。
- **多模态与语音转写**：支持拖拽/粘贴图片预览、语音一键转写 Prompt，以及代码文件与行号跳转预览模态框。
- **远程 Telegram Connector**：可选的独立单用户 Connector，支持文本对话、会话控制与任务终态通知，不将 Telegram 依赖加载到 Core。

---

## 快速开始

### 1. 环境依赖
- **Node.js**: `>= 24.0.0`
- **npm**: 确保具备 C++ 编译环境以支持 `better-sqlite3` 原生模块构建。
- **Agent runtime**: 本机已安装并配置 `codex` App-Server CLI。

### 2. 安装与构建
```bash
git clone https://github.com/Andy963/ads.git
cd ads
npm install
npm run build
```

### 3. 初始化管理员
首次启动前需创建 Web Console 管理员账号：
```bash
npm run web:init-admin -- --username admin --password-stdin
```

### 4. 启动服务
- **生产方式启动 Web Console**：
  ```bash
  npm start
  # or
  npm run web
  ```
  默认监听 `http://127.0.0.1:8787`。

- **开发调试模式**：
  ```bash
  npm run dev       # 服务端源码监听 (tsx watch)
  npm run dev:web   # 前端 Vite 热重载开发服务器
  ```

- **启动 Telegram Connector（可选）**：
  ```bash
  export TELEGRAM_BOT_TOKEN="your-bot-token"
  export TELEGRAM_ALLOWED_USER_ID="your-user-id"
  export ADS_CONNECTOR_TOKEN="your-shared-core-token"
  node connectors/telegram/bin/ads-telegram.js start
  ```

---

## 模块文档索引

详细的模块说明与进阶指南请查阅 `docs/` 目录：

- 🎯 **[Codex 技能规范与架构说明](docs/adr/0007-align-skills-with-codex-standard.md)**：全局 `$CODEX_HOME/skills`、优先级（global > builtin）、`<skill_save>` 自动沉淀与迁移机制。
- 📖 **[Web Console 完整使用指南](docs/web.md)**：工作区 Tab、Provider 模型管理、移动端交互规范与 Web 专属配置。
- 📱 **[Telegram Connector 配置与使用手册](docs/telegram.md)**：Connector 设置、文本会话与任务终态通知。
- 🏛 **[系统架构与核心机制](docs/architecture.md)**：双层 SQLite 数据模型、Agent 适配器层、Durable Sync 状态同步协议与调度器引擎。
- ⚙️ **[完整环境变量配置参考](docs/configuration.md)**：核心配置、Web、Agent、Skills/Memory、Scheduler 及可选 Connector 配置全览。

---

## 常用开发命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 完整构建（TypeScript 编译 + 资源同步 + Vite 前端打包） |
| `npm run build:web` | 仅重新打包前端 Web 资源 |
| `npm run test` | 运行服务端完整单元测试（Node test runner） |
| `npm run test:web` | 运行前端 Vitest 组件与状态测试 |
| `npm run lint` | 运行 ESLint 代码规范检查 |
| `npm run skills:migrate` | 运行技能迁移 CLI，将遗留技能非破坏性迁移至 Codex 标准目录 |
| `npm run web:reset-admin` | 重置或创建新的 Web 管理员账号 |

---

## 项目目录结构

```text
ads/
├── connectors/        # Channel Connectors (e.g. telegram)
│   └── telegram/      # Standalone Telegram channel connector
├── server/            # Core backend engine
│   ├── agents/        # Codex App-Server 适配器与执行守护器
│   ├── middleware/    # Core middleware pipeline (memory, safety, hooks)
│   ├── rules/         # 内置安全执行网关
│   ├── scheduler/     # 自然语言定时调度引擎与 Cron 运行时
│   ├── sessions/      # Session, directory, and thread persistence
│   ├── state/         # 全局 SQLite (state.db) 数据表与迁移
│   ├── storage/       # 工作区独立 SQLite (ads.db) 数据表与迁移
│   ├── tasks/         # 任务队列、执行器与状态流转
│   └── web/           # Web HTTP API、WebSocket Hub 与鉴权系统
├── client/            # 前端 Web Console 源码 (Vue 3 + TypeScript + Vite)
├── docs/              # 模块化详细设计与配置文档
├── templates/         # 运行时 Prompt 与种子模板
└── tests/             # 后端完整测试用例集
```

---

## License

MIT License. See [LICENSE](LICENSE).
