# ADS (Agent Dispatch & Orchestration System)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

ADS 是一个面向 AI 编程工作流的本地 Web Console 与智能任务编排中枢。它以项目工作区为核心，围绕 Acopilot（Issue、实现与 PR）/ Actions（Reviewer 队列）双 Lane 构建 AI 开发工作流。Agent 运行时提供双引擎：默认使用进程内原生运行时（Native Runtime），直连 OpenAI 兼容端点并执行工具；也可通过 `ADS_AGENT_RUNTIME=codex-app-server` 切换到 Codex App-Server 统一接入多 Provider 模型。同时还支持可选的独立 Channel Connector。

---

## 核心特性

- **现代 Web Console**：基于 Vue 3 + Vite 构建的响应式控制台，支持移动端抽屉导航与桌面端全功能布局。
- **双 Lane 协作工作流**：顶层只有 `Acopilot` 与 `Actions` 两个 Lane，角色只有 Acopilot 与 Reviewer（见 [ADR 0027](docs/adr/0027-canonical-lane-and-actions-role-terminology.md)）。
  - **Acopilot**：负责调查、创建 GitHub Issue、实现代码、验证、准备 PR，并根据评审结果返工。
  - **Actions**：仅运行只读 Reviewer 队列；评审进度和结果显示在 Actions 队列与会话中，不执行实现或自动合并。
- **双引擎 Agent 运行时**：默认使用进程内 **Native Runtime**，直连 OpenAI 兼容端点并执行工具；设置 `ADS_AGENT_RUNTIME=codex-app-server` 可切换到 **Codex App-Server** 路由多 Provider 模型（包括 Anthropic Claude、Google Gemini 与 DeepSeek）。支持模型可视化启用/停用与即时配置。
- **确定性安全拦截**：在命令执行边界保护 ADS 自身进程和 SQLite 数据库文件，不依赖模型提示或可变数据库规则。
- **Codex 标准技能体系**：全局技能原生对齐 `$CODEX_HOME/skills`（默认 `~/.codex/skills`）；支持对话中 `<skill_save>` 自动沉淀与存量遗留技能无损原子迁移，与 native Codex CLI 完全互通。
- **会话恢复 (Session Resume)**：`codex-app-server` 下零 Token 冗余续接底层 CLI 真实历史上下文；Native 下续接 durable transcript，必要时用本地历史做上下文注入；断线重连自动增量同步。
- **多模态与语音转写**：支持拖拽/粘贴图片预览、语音一键转写 Prompt，以及代码文件与行号跳转预览模态框。
- **远程 Telegram Connector**：可选的独立单用户 Connector，支持文本对话、会话控制与任务终态通知，不将 Telegram 依赖加载到 Core。

---

## 快速开始

### 1. 环境依赖
- **Node.js**: `>= 24.0.0`
- **npm**: 确保具备 C++ 编译环境以支持 `better-sqlite3` 原生模块构建。
- **Agent runtime**: 默认后端是进程内 Native Runtime，只需配置可用的对话模型服务商，无需安装 `codex` CLI；命令直接在宿主机上执行，与 Web 工作区的 `danger-full-access` 语义一致，请仅在单租户自托管环境启用。只有在 `ADS_AGENT_RUNTIME=codex-app-server` 时才需要本机安装并配置 `codex` App-Server CLI。

### 2. 安装与构建
```bash
git clone https://github.com/Andy963/ads.git
cd ads
npm ci --prefix client
npm ci --prefix ts-server
npm --prefix client run build
npm --prefix ts-server run build
```

### 3. 初始化管理员
首次启动前需创建 Web Console 管理员账号：
```bash
npm --prefix ts-server run web:init-admin -- --username admin --password-stdin
```

### 4. 启动服务
- **生产方式启动 Web Console**：
  ```bash
  npm --prefix ts-server start
  # or
  npm --prefix ts-server run web
  ```
  默认监听 `http://127.0.0.1:8787`。

- **开发调试模式**：
  ```bash
  npm --prefix ts-server run dev   # 服务端源码监听 (tsx watch)
  npm --prefix client run dev      # 前端 Vite 热重载开发服务器
  ```

- **启动 Telegram Connector（可选）**：
  ```bash
  export TELEGRAM_BOT_TOKEN="your-bot-token"
  export TELEGRAM_ALLOWED_USER_ID="your-user-id"
  export ADS_CONNECTOR_TOKEN="your-shared-core-token"
  node ts-server/connectors/telegram/bin/ads-telegram.js start
  ```

---

## 模块文档索引

详细的模块说明与进阶指南请查阅 `docs/` 目录：

- 🗂️ **[架构决策记录 (ADR) 索引](docs/adr/README.md)**：ADR 0001–0048 的决策记录链接索引。
- 📋 **[Acopilot & Actions 协同规格](docs/acopilot-actions-spec.md)**：Acopilot 负责 Issue、实现、PR 与返工；Actions 泳道内的只读 Reviewer 负责精确提交评审。
- 🎯 **[Codex 技能规范与架构说明](docs/adr/0007-align-skills-with-codex-standard.md)**：全局 `$CODEX_HOME/skills`、优先级（global > builtin）、`<skill_save>` 自动沉淀与迁移机制。
- 🏗 **[原生 Agent 运行时 (ADR 0013)](docs/adr/0013-native-agent-runtime-phase-1.md)**：进程内 Native Runtime 的设计、工具沙箱与凭据边界。
- 📖 **[Web Console 完整使用指南](docs/web.md)**：工作区 Tab、Provider 模型管理、移动端交互规范与 Web 专属配置。
- 📱 **[Telegram Connector 配置与使用手册](docs/telegram.md)**：Connector 设置、文本会话与任务终态通知。
- 🏛 **[系统架构与核心机制](docs/architecture.md)**：双层 SQLite 数据模型、Agent 适配器层、Durable Sync 状态同步协议与调度器引擎。
- ⚙️ **[完整环境变量配置参考](docs/configuration.md)**：核心配置、Web、Agent、Skills/Memory、Scheduler 及可选 Connector 配置全览。

---

## 常用开发命令

| 命令 | 说明 |
|---|---|
| `npm --prefix client run build` | 构建 Web client 到 `client/dist/` |
| `npm --prefix ts-server run build` | 编译 TypeScript server 到 `ts-server/dist/` 并复制运行时资产 |
| `npm --prefix client run build:fixture` | 打包包含浏览器测试 fixture 入口（fixture.html）的前端构建 |
| `npm --prefix ts-server test` | 运行 TypeScript server 测试 |
| `npm --prefix client test` | 运行前端 Vitest 组件与状态测试 |
| `npm --prefix client run lint` | 检查 client 代码规范 |
| `npm --prefix ts-server run lint` | 检查 TypeScript server 代码规范 |
| `npm --prefix ts-server run skills:migrate` | 运行技能迁移 CLI，将遗留技能非破坏性迁移至 Codex 标准目录 |
| `npm --prefix ts-server run web:reset-admin` | 重置或创建新的 Web 管理员账号 |

---

## 项目目录结构

```text
ads/
├── client/            # Shared Web Console (Vue 3 + TypeScript + Vite), package.json and dist owned here
├── rust-server/       # Rust backend and Rust Telegram connector crate
│   └── crates/ads-telegram/
├── ts-server/         # TypeScript backend package, tests, build scripts, and Telegram connector
│   ├── package.json
│   ├── dist/
│   ├── server/
│   ├── shared/
│   ├── tests/
│   └── connectors/telegram/
└── docs/              # Architecture, configuration, and migration docs
```

---

## License

MIT License. See [LICENSE](LICENSE).
