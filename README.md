# ADS (Agent Dispatch & Orchestration System)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

ADS 是一个面向 AI 编程工作流的本地 Web Console 与智能任务编排中枢。它以项目工作区为核心，围绕 Advisor（方案规划）/ Worker（代码执行）/ Task（任务看板与队列）构建了一体化的 AI 开发工作流，并支持多 Provider CLI 接入与可选的 Telegram Bot 远程交互。

---

## 核心特性

- **现代 Web Console**：基于 Vue 3 + Vite 构建的响应式控制台，支持移动端抽屉导航与桌面端全功能布局。
- **三 Tab 协作工作流**：
  - **Task (任务看板)**：可视化任务排队、执行、重试、错误追踪及 Task Bundle 任务草稿审批。
  - **Advisor (规划 Lane)**：专属架构方案研讨；任务草稿可直接引用 GitHub Issue/PR 或使用自包含 prompt，不要求本地 issue/spec 文档。
  - **Worker (执行 Lane)**：有本地快照时读取批准时固定的 issue/spec 内容，否则直接依据任务 prompt 与 GitHub 引用执行，实时输出紧凑预览。
- **多 Provider CLI 支持**：原生适配 **OpenAI Codex**、**Anthropic Claude Code** 与 **Factory Droid CLI**，支持模型可视化启用/停用与即时配置。
- **全局规则引擎 (Global Rules)**：跨项目、跨终端（Web / Telegram）统一注入 system prompt 规范，支持在线测试与修改即时生效。
- **原生会话恢复 (Session Resume)**：零 Token 冗余恢复底层 CLI 真实历史上下文，断线重连自动增量同步。
- **多模态与语音转写**：支持拖拽/粘贴图片预览、语音一键转写 Prompt，以及代码文件与行号跳转预览模态框。
- **远程 Telegram 控制**：可选单用户安全 Bot，支持远程对话、命令执行、语音/图片输入与任务终态通知。

---

## 快速开始

### 1. 环境依赖
- **Node.js**: `>= 24.0.0`
- **npm**: 确保具备 C++ 编译环境以支持 `better-sqlite3` 原生模块构建。
- **Agent CLI**: 本机已安装并配置 `codex`、`claude` 或 `droid`。

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

- **启动 Telegram Bot（可选）**：
  ```bash
  export TELEGRAM_BOT_TOKEN="your-bot-token"
  export TELEGRAM_ALLOWED_USER_ID="your-user-id"
  node dist/server/cli.js telegram
  ```

---

## 模块文档索引

详细的模块说明与进阶指南请查阅 `docs/` 目录：

- 📖 **[Web Console 完整使用指南](docs/web.md)**：工作区 Tab、Provider 模型管理、全局规则系统、移动端交互规范与 Web 专属配置。
- 📱 **[Telegram Bot 配置与使用手册](docs/telegram.md)**：Bot 设置、完整指令清单、多模态语音交互与权限保护。
- 🏛 **[系统架构与核心机制](docs/architecture.md)**：双层 SQLite 数据模型、Agent 适配器层、Durable Sync 状态同步协议与调度器引擎。
- ⚙️ **[完整环境变量配置参考](docs/configuration.md)**：核心配置、Web、Agent、Rules/Memory、Scheduler 及 Telegram 变量全览。

---

## 常用开发命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 完整构建（TypeScript 编译 + 资源同步 + Vite 前端打包） |
| `npm run build:web` | 仅重新打包前端 Web 资源 |
| `npm run test` | 运行服务端完整单元测试（Node test runner） |
| `npm run test:web` | 运行前端 Vitest 组件与状态测试 |
| `npm run lint` | 运行 ESLint 代码规范检查 |
| `npm run web:reset-admin` | 重置或创建新的 Web 管理员账号 |

---

## 项目目录结构

```text
ads/
├── server/            # 服务端源码 (Node.js / Express-WS / Telegram)
│   ├── agents/        # Agent CLI 适配器与执行守护器 (Codex / Claude / Droid)
│   ├── rules/         # 全局规则服务与执行网关
│   ├── scheduler/     # 自然语言定时调度引擎与 Cron 运行时
│   ├── state/         # 全局 SQLite (state.db) 数据表与迁移
│   ├── storage/       # 工作区独立 SQLite (ads.db) 数据表与迁移
│   ├── tasks/         # 任务队列、执行器与状态流转
│   ├── telegram/      # Telegram Bot 控制逻辑与多模态处理器
│   └── web/           # Web HTTP API、WebSocket Hub 与鉴权系统
├── client/            # 前端 Web Console 源码 (Vue 3 + TypeScript + Vite)
├── docs/              # 模块化详细设计与配置文档
├── templates/         # 运行时 Prompt 与种子模板
└── tests/             # 后端完整测试用例集
```

---

## License

MIT License. See [LICENSE](LICENSE).
