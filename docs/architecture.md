# ADS 系统架构与核心机制

ADS (Agent Dispatch & Orchestration System) 采用分层解耦的架构设计，提供本地优先（Local-first）、多 Agent 协作、双层持久化与高可靠的状态同步机制。

---

## 1. 系统分层设计

```text
┌──────────────────────────────────────────────────────────────┐
│                       交互端 / Clients                        │
│   Web Console (Vue 3 + Vite)   │   Telegram Bot (GrammY)     │
└──────────────┬─────────────────┴──────────────┬───────────────┘
               │                                │
               │ HTTP / WebSocket               │ Long Polling
               ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│                     服务端服务层 / Server Core                 │
│  - HTTP API & Auth Router (Cookie Session / Rate Limiter)     │
│  - WebSocket Hub & Sync Sequencer (Durable Event Log)         │
│  - Advisor / Worker Prompt Orchestration                      │
│  - Global Rule Service & Enforcement Gate                     │
│  - Scheduler Runtime (Cron Engine & Spec Compiler)            │
└──────────────┬────────────────────────────────┬───────────────┘
               │                                │
               ▼                                ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐
│       Agent 适配器层          │ │        双层存储系统          │
│ - Codex App Server (RPC)     │ │ - 全局库: state.db           │
│   (统一路由所有 Provider 模型) │ │   (用户/会话/模型/规则)       │
│                              │ │ - 工作区库: <ws>/ads.db      │
│                              │ │   (附件/调度/历史)            │
└──────────────────────────────┘ └──────────────────────────────┘
```

---

## 2. 核心架构特性

模型切换按 provider 能力处理：支持同线程切换的 adapter 保留 native thread；不支持的 adapter 只清除当前 agent 的线程并走历史注入，不影响其他 agent 的线程绑定。

### 2.0 统一会话消息记录

Web 与 Telegram 保留各自现有的本地存储和消息交付行为。通道接受最终用户消息或成功记录最终 Agent 回复后，还会通过 `server/utils/conversationMessageRecorder.ts` 中的共享 `ConversationMessageRecorder` 契约发布规范化消息。

该契约携带消息 ID、工作区、会话、来源、角色、正文及可用的 Agent 身份。消费者是可选且隔离的：recorder 抛错不得影响本地持久化、模型调用或通道交付。流式增量、命令、状态事件、工具输出和错误不属于最终会话消息，不通过该契约发布。

### 2.1 双层存储模型 (Two-Tier Storage)
- **全局状态库 (`state.db`)**：
  - 存放 Web 管理员账号、认证 Session、模型管理配置、跨工作区全局规则（Global Rules）以及多工作区注册表。
  - 路径：`$ADS_STATE_DIR/state.db`。
- **工作区独立存储 (`ads.db`)**：
  - 每个由 ADS 管理的工作区在 `.ads/workspaces/<workspace-id>/ads.db` 维持独立的 SQLite 数据库。
  - 隔离存储该工作区下的本地附件（Attachments）、定时调度（Schedules）、调度运行记录与工作区专属记忆。历史任务表保留为只读兼容数据，不再参与 Web 工作流。
  - 数据天然按项目隔离，便于清理、备份与迁移。

### 2.2 多 Agent 抽象与容错执行
- **统一适配器抽象 (`AgentAdapter`)**：
  - 通过 Codex App-Server 标准化封装多 Provider 模型的 RPC 调用、结构化事件与进程生命周期。
  - 支持 Codex App Server JSON-RPC 长连接与一次性 CLI 的无缝降级。
- **上游重试与自愈 (Upstream Retry & Healing)**：
  - 自动识别限流（429）、服务器高负载（503）、Cloudflare/网关超时（520–524）以及上游安全拦截。
  - 仅在未产生命令执行或文件写入等副作用前，自动指数退避重试，保障网络波动下的任务可靠性。
- **进程守卫 (Execution Governor)**：
  - 动态限制并发 CLI 实例数，提供空闲看门狗（Idle Watchdog）与最大硬超时保护，防止僵尸进程耗尽系统资源。

### 2.2.1 Agent Turn Middleware
- `server/middleware/` 提供可组合的 Turn/Item 生命周期钩子。
- `runAgentTurn` 支持注入 middleware pipeline，用于输入预处理、回合启动、输出后处理和错误收尾。
- Item 级安全钩子失败时默认拒绝执行；输出 artifact 使用私有目录和 `0600` 文件权限。

### 2.3 状态同步协议与双向通信 (Durable Sync Protocol)
- 客户端与服务端基于增量序列号（`seq`）与 WebSocket 建立长连接通信。
- 服务端记录不可篡改的 `SyncEvent` 事件流，客户端断线重连后通过 `/api/sync/events?afterSeq=...` 自动对账补齐断线期间产生的所有消息与命令事件。
- 每个浏览器标签页维持独立的同步游标，避免多标签页状态竞争或事件丢失。

### 2.4 定时任务与编译引擎 (Scheduler Engine)
- 内置 Cron 调度引擎，支持自然语言定时指令编译。
- Advisor / Worker 输出符合规格的 `ads-schedule` 代码块后，由编译器校验并存入调度器，定时驱动无头 Agent 直接执行冻结的 Prompt，并将结果写入 `schedule_runs`。
