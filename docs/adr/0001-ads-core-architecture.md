# ADR-0001：ADS 核心架构与关键技术决策（基于当前代码归纳）

- 状态：Accepted（已在代码中落地；本文为“整理归档”）
- 整理日期：2025-12-22
- 适用范围：本仓库 `ads` 工具本身（Web Console / Telegram Bot），而非某个具体的 ADS workspace

## 背景 / 要解决的问题

ADS 的目标是把“规格驱动开发”（需求 → 设计 → 实施/验证）的流程固化为可执行的工作流，并让同一套工作流可以通过多个入口（Web Console、Telegram Bot）触达。同时需要：

- 将工作流与上下文持久化（跨进程/跨会话可恢复）。
- 支持多模型/多代理（Codex/Claude/Gemini）与工具调用闭环。
- 在“能跑起来”的同时，尽量减少对用户项目的侵入，并提供目录白名单等安全护栏。

本文从当前代码实现中提炼“已经做出的架构决策”，用于团队沟通与后续演进参考。

## 决策（从代码行为归纳）

### 1) 技术栈：Node.js + TypeScript（ESM）

- 代码以 TypeScript 编写、ESM 运行时（`package.json` 的 `"type": "module"`）。
- 构建方式：`tsc` 编译到 `dist/`，并在构建时复制 `templates/`（`package.json` 的 `build` 脚本）。
- 运行要求：`package.json` 的 `"engines": { "node": ">=20" }`。

**动机（从代码组织推断）：**
- 单一语言覆盖 WebSocket/HTTP 服务、Telegram Bot 等多入口。
- 与上游 SDK（如 `@openai/codex-sdk`、Telegram `grammy` 等）天然贴合。

### 2) 持久化：使用 SQLite（better-sqlite3），并区分“工作流图数据库”和“运行态状态库”

#### 2.1 工作流/规格图数据库：`ads.db`

- 数据库访问入口：`src/storage/database.ts`
- 迁移定义：`src/storage/migrations.ts`
- 核心表（迁移 v1）：`nodes`、`node_versions`、`edges`、`workflow_commits`，以及 `schema_version`（在 `src/storage/database.ts` 内维护）
- 访问模式：`better-sqlite3` 同步 API，设置 `journal_mode=WAL`、`foreign_keys=ON`（`src/storage/database.ts`）

**工作流数据模型（从表结构 + graph CRUD 推断）：**
- 工作流与规格步骤以“图”的形式表示：节点（node）+ 边（edge）。
- 节点具备草稿与版本化能力：`nodes` 表同时包含 `content/current_version` 与 `draft_*` 字段；历史版本写入 `node_versions`。
- 工作流“定稿/推进”会写入提交日志：`workflow_commits`（见 `src/workflow/service.ts` 的 `recordWorkflowCommit`）。

#### 2.2 运行态状态库：`state.db`

- 数据库访问入口：`src/state/database.ts`
- 表结构：`kv_state`（键值）、`thread_state`（线程与 cwd）、`history_entries`（会话历史）（见 `src/state/database.ts`）
- 使用场景（从 Web/History 代码推断）：
  - Web Console 的 cwd 记忆与迁移（`src/web/utils.ts` 的 `loadCwdStore/persistCwdStore`）
  - 历史对话持久化（`src/utils/historyStore.ts`、`src/web/server.ts` 初始化 HistoryStore）

**为什么要拆两类 DB（从代码分层推断）：**
- `ads.db` 关心“规格图/工作流”的强结构化数据与迁移版本；
- `state.db` 更偏“运行态元数据/缓存/历史”，写频更高、结构更轻，隔离后便于迁移与演进。

### 3) 工作流模板与 spec 文件：仓库 `templates/` 为单一真源，启动时同步到 workspace

- 模板目录：`templates/`（固定 6 个平面文件：`instructions.md`、`rules.md`、`requirement.md`、`design.md`、`implementation.md`、`workflow.yaml`）
- 工作区模板同步逻辑：`src/workspace/detector.ts`（`copyDefaultTemplates` + `ensureDefaultTemplates`）
- `workflow.yaml` 描述 step 顺序与 node 类型映射（示例模板 `unified`：需求→设计→实施）

**隐含约束：**
- 模板被视为工作流与提示词的核心配置面；workspace 侧 `.ads/templates/` 允许覆盖并热加载（见 `src/systemPrompt/manager.ts` 对 `.ads/templates/instructions.md` 的读取策略）。

### 4) 多入口（同一套工作流能力，多个交互面）

#### 4.1 Web Console（HTTP + WebSocket）

- 入口：`src/web/server.ts`
- 默认监听：`ADS_WEB_PORT`（默认 8787）、`ADS_WEB_HOST`（默认 `0.0.0.0`）
- 可选 Token：`ADS_WEB_TOKEN`
- 以 WebSocket 进行交互、支持 interrupt controller（见 `src/web/server.ts` 的 `interruptControllers`）
- 目录白名单：`ALLOWED_DIRS`（默认仅 workspace root；`src/web/utils.ts` 的 `resolveAllowedDirs`）

#### 4.2 Telegram Bot（远程控制入口）

- 入口：`src/telegram/bot.ts`
- 框架：`grammy`
- 关键护栏：
  - 用户白名单（`createAuthMiddleware`）
  - 速率限制（`createRateLimitMiddleware`）
  - 目录白名单（`DirectoryManager`：`src/telegram/utils/directoryManager.ts`）
  - workspace 初始化提示与“回复肯定词自动初始化”（`checkWorkspaceInit` + `AFFIRMATIVE_RESPONSES` + `initializeWorkspaceForUser`）

### 5) 多代理编排：Hybrid Orchestrator + delegation blocks + tool loop

- Orchestrator：`src/agents/orchestrator.ts`（可注册多个 Adapter、切换 active agent、广播 cwd/model、合并 system prompt）
- 协作/委派：`src/agents/hub.ts`
  - 解析 `<<<agent.xxx ... >>>` 委派块
  - 对支持的 agent 运行工具回合（`executeToolBlocks`），并把工具结果反馈给 agent 继续完成任务
- 系统提示注入：`src/systemPrompt/manager.ts`
  - 读取 workspace 的 `.ads/templates/instructions.md` 与 `.ads/rules.md`
  - 支持按 turn 周期 reinjection（默认指令每 6 轮、规则每 1 轮）

### 6) 安全与流程护栏（工程化约束）

- 目录白名单：Telegram/Web 侧都通过白名单限制可操作目录（`DirectoryManager`、`resolveAllowedDirs`）
- Workspace 初始化检测：`src/telegram/utils/workspaceInitChecker.ts`（检查 `.ads/workspace.json` 与 `.ads/templates/instructions.md`）

## 影响 / 后果（Pros / Cons）

### 收益

- **统一的工作流内核，多入口复用**：Web/Telegram 共享同一套 workflow/service、graph/storage。
- **本地可持久化、易分发**：SQLite + 文件模板使得 workspace “带走即用”，无需额外服务依赖。
- **规格与实现强绑定**：图模型 + `workflow_commits` 让“定稿/推进”可追溯，并能把 spec 文件与 review bundle 关联（`src/review/service.ts` 会打包 spec + git diff）。
- **可扩展的多代理策略**：Hybrid Orchestrator 允许新增 Adapter，并支持委派与工具闭环。

### 代价 / 风险

- **同步 SQLite 的并发与锁**：`better-sqlite3` 同步模型简单，但多进程/高并发场景需要谨慎（WAL 缓解但不等于无锁）。
- **初始化/同步可能带来“意外写入”**：对未初始化的 workspace 进行初始化/模板同步会写入状态文件；需要在交互面提供明确提示与确认。
- **模板同步会清理 workspace `.ads/templates/` 非模板文件**：`copyDefaultTemplates` 会移除不在源集合中的文件；需要明确这是“受控目录”。
- **多入口状态分散**：graph DB 与 state DB 分离利于演进，但也增加了排障复杂度（需要同时关注 `.ads/ads.db` 与 `.ads/state.db`）。

## 关键实现点索引（便于读代码）

- 工作流服务（status/new/commit/log/checkout）：`src/workflow/service.ts`
- 图存储 schema/迁移：`src/storage/migrations.ts`
- 图存储连接与迁移运行：`src/storage/database.ts`
- 图 CRUD：`src/graph/crud.ts`
- Workspace 探测/模板同步/初始化：`src/workspace/detector.ts`
- Web Console：`src/web/server.ts`、`src/web/utils.ts`
- Telegram Bot：`src/telegram/bot.ts`
- Review 打包与报告：`src/review/service.ts`
- System prompt 注入：`src/systemPrompt/manager.ts`
- Agent 编排：`src/agents/orchestrator.ts`、`src/agents/hub.ts`

## 可替代方案（对比项，仅供未来演进评估）

> 说明：以下是从“现有决策的反面”推导的替代路线，不代表历史上一定讨论过。

1. **持久化用 JSON/YAML 文件替代 SQLite**
   - 优点：人可读、调试方便、无需 DB 迁移
   - 缺点：并发写入困难、查询与版本化复杂、历史与索引性能差
2. **将工作流状态放到 Postgres/Server 端**
   - 优点：多用户/多实例扩展更容易
   - 缺点：引入服务依赖，降低“本地即用”；部署与权限复杂
3. **把模板升级为可组合的目录结构**
   - 优点：更强扩展性（多模板、多片段）
   - 缺点：同步/热更新/兼容性复杂度上升；需要更明确的模板规范与版本管理

## 结论

当前 ADS 的代码体现出一个明确的方向：以“本地、可持久化、模板驱动、图模型工作流”为内核，通过多个入口暴露统一能力，并用 system prompt reinjection + 多代理编排形成闭环。后续的演进优先级应围绕：更严格的 workspace 写入策略（减少意外写入）、更清晰的模板/DB 版本兼容、以及多入口状态观测与诊断能力。
