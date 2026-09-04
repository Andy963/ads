# ADS Web Console

ADS Web Console 是一个轻量级、响应式的 AI 辅助编程浏览器端界面。

---

## 核心功能与工作流

### 1. 工作区与双 Lane 结构 (Workspace Dual-Lane)
Web Console 聚焦于双 Lane 交互界面与 GitHub-Native 交付流：
- **Advisor (规划 Lane)**：
  - 默认规划 Lane，用于方案讨论、代码架构设计与 Issue 拆解。
  - 采用 GitHub-native 规范：在 GitHub Issues 中追踪需求、根因、范围与验收条件。
  - 支持输出 `ads-schedule` 声明式定时任务指令，由 Scheduler 独立调度执行。
  - 无本地文件写入守卫限制，全面支持通过 GitHub CLI (`gh`) 等工具维护协作记录。
- **Worker (执行 Lane)**：
  - 专注于代码执行、命令运行与文件修改的执行 Lane，支持直接对话交互。
  - 配合 `worker-pr-lifecycle` 规范，在独立的 worktree 中完成编码、验证、测试与 PR 提交。
  - 实时展示阶段 trace（如 `[analysis]`、`[tool]`、`[editing]`）与命令执行输出；文件变更由 Patch 卡片展示。
  - Plan 卡片按单轮逻辑计划合并 provider 更新，并在任务完成与历史重连时保持唯一且状态一致。

### 2. Provider 模型与全局配置 (Provider & Models)
- **统一 Codex App-Server 接入**：
  - 所有模型（包括 Anthropic Claude、Google Gemini 与 DeepSeek）均通过 Codex App-Server 路由。
  - 模型管理页提供单一的模型列表，不再按 CLI Provider 分组。
- **模型管理**：
  - 在线启用/停用模型、设置默认模型、编辑与新增模型。
  - 输入框模型选择器严格联动：仅展示当前 Agent 兼容且已启用的模型，切换 Agent 时自动恢复对应兼容偏好。页面加载或模型列表刷新不会覆盖已有的自定义模型选择。
  - 所有模型配置持久化于全局 SQLite 状态库 (`state.db`)。

### 2.1 流式回复增量与阶段边界协议 (Streaming & Phase Boundaries)

- **消息增量隔离**：WebSocket 流式回复按 Provider 的消息 `itemId` 隔离累计文本；多个 agent message、工具调用和 reasoning item 交错时，不会把其他 item 的完整快照重复追加到当前回复。前端还会忽略已接收的重复累计前缀，作为传输异常时的最后一道保护。
- **阶段边界事件 (`phase_complete`)**：当单个 assistant `agent_message` 块完成时，服务端派发显式的 `phase_complete` 事件，通知客户端与重放流封板当前回复气泡并置 `streaming: false`。后续的回复增量会独立创建新气泡，即使没有命令或工具卡片交错，也不会将逻辑上独立的解释文本拼接进同一个气泡中。
- **阶段化快照持久化与跨轮次无碰撞 ID (`delta_snapshot`)**：增量同步日志中，流式快照按执行阶段分段持久化（`eventId` 格式为 `stream:<laneKey>:<streamId>:<phase>`，其中 `streamId` 对每个活动 stream 唯一）。轮次终端结算 (`finish`) 仅清理当前未封板的活跃快照，严禁删除已封板阶段；新建或重连的 Coalescer 使用新的 stream ID，避免覆盖前序轮次已封板的快照。每当收到 `phase_complete`，当前阶段的 `delta_snapshot` 刷盘封板保留，作为可靠的断线重放记录；重放顺序严格保持 `delta_snapshot (phase 1) -> phase_complete -> delta_snapshot (phase 2) -> ...`。
- **用户消息同步事件与原子性回滚 (`user`)**：Preflight 阶段保存用户提示词后，同步向 `SyncEventStore` 追加 `type: "user"` 增量事件，保持增量流与完整历史具有相同的回合拓扑（user -> command -> result）。若增量事件写入失败，服务端立即按精确 `kind` 回滚刚刚写入历史库的提示词条目并返回错误，确保客户端重试时不会因历史重复而遭到拦截。
- **断线重连与双向历史对齐 (History Gap Reconciliation)**：前端对齐算法采用 LCS（最长公共子序列）执行双向对齐，当断线重放或重新拉取历史时，自动回填因连接抖动而在本地遗漏的中间用户消息与助手回复，并保留各事件在 `state.db` 中持久化的原始时间戳与执行元数据。

### 3. 全局规则系统 (Global Rules)
- 跨项目、跨 Channel（Web Console / Telegram Bot）以及统一 Codex 引擎生效的规则引擎。
- 规则分为四种级别：`advisory`（建议）、`required`（必须遵守）、`approval_required`（需审批）、`blocked`（阻断）。
- 支持在线规则编辑、启用/停用、匹配模式过滤（针对特定 Agent、工具或路径）。
- 提供 **注入预览 (Preview)** 与 **规则测试面板 (Test Playground)**，修改后实时保存至数据库，下一轮对话即时注入 `<global_rules>` 上下文生效，无需重启服务。

### 4. 原生会话恢复与历史管理 (Session Resume)
- 点击工具栏 **「历史会话」** 打开恢复选择器。
- 自动扫描并展示当前项目工作区下的 Codex 原生会话（标题、更新时间、轮数统计）。
- 原生恢复：直接按 CLI 底层 session 续接，不重复注入历史文本，保留完整的 Token 上下文与缓存状态。
- 会话文件健康判定：断线或重连时若会话文件存在则原生恢复，缺失时平滑降级并友好提示。
- 新建聊天会话时，在线 WebSocket 通过原连接内协议切换 session；连接状态保持在线，离线时自动回退到完整重连。
- 重连或后端重启后，只要持久化历史存在就会发送历史快照；即使后端上下文暂时是 fresh，客户端也保留本地聊天记录，只有显式线程重置才会清空历史。
- Bootstrap 等待期间提交的提示会进入持久 outbox，待历史同步完成后继续发送；若历史帧丢失，5 秒兜底会解除等待锁，避免 Composer 永久冻结。
- 清空或新建会话不会删除 Composer 中尚未提交的草稿文本；Advisor 每轮消息遵循固定卡片契约：`User -> Plan -> 当前 Process/Thought -> Execute（按命令顺序） -> Patch -> Final assistant`。该顺序由前端按当前轮重新归一化，不依赖 WebSocket 事件到达顺序，因此 command-before-process、process-before-command、重连 catch-up 与历史回放都会保持一致；活动中的 live-step 只保留最新阶段快照，完成后该快照会作为可折叠 Thought 卡片保留在历史重放中。
- Worker 与 Advisor 的清空操作默认只作用于发起操作的 chat lane；跨 lane 清理必须显式请求 shared scope，且 session reset 广播会校验来源 lane。

### 5. 多模态与文件联动
- **多模态图片附件**：支持拖拽、粘贴与上传图片，MainChat 提供紧凑缩略图预览与大图查看器。
- **语音输入 (Voice Input)**：内置基于 Whisper / Groq 的语音转写，点击麦克风录音即可实时转为 Prompt 输入文本。
- **文件与行号跳转预览 (File Preview Modal)**：
  - 对话中输出的代码路径或链接（如 `src/app.ts#L42`）自动渲染为高亮交互链接。
  - 点击即可弹出文件预览模态框，支持语法高亮、精准行号高亮、相邻窗口分页与一键复制。

---

## 移动端适配 (Mobile Experience)

Web Console 经过专门的移动端交互优化：
1. **抽屉式导航 (Drawer Navigation)**：左上角汉堡菜单可无缝滑出抽屉，按 **项目 (Projects)**、**规则 (Rules)**、**模型 (Models)** 进行全局模块切换。
2. **双 Tab 扁平导航**：移动端顶栏按 `Advisor | Worker` 排布；首次使用或项目没有记录时聚焦 Advisor，之后按项目恢复上次打开的 Tab。
3. **独立上下文菜单 (Context Actions)**：右上角根据当前激活模块提供专属操作（如恢复会话、新建会话、新增规则、刷新模型列表等），语言与操作深度统一。
4. **软键盘自适应**：自动侦测移动端虚拟键盘开启与高度，精确调整底部 Composer 避让，消除空白与遮挡。

---

## Web 相关环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADS_WEB_HOST` | `127.0.0.1` | Web 服务监听地址 |
| `ADS_WEB_PORT` | `8787` | Web 服务监听端口 |
| `ADS_WEB_ALLOWED_ORIGINS` | 未设置 | 跨域与 WebSocket 允许来源，未设置时仅放行同源与 localhost |
| `ADS_WEB_SESSION_TTL_SECONDS` | `604800` (7天) | 登录 Session Cookie 有效期（秒） |
| `ADS_WEB_SESSION_PEPPER` | 空 | Session Token 哈希混淆 Pepper |
| `ADS_WEB_COOKIE_SECURE` | `auto` | Cookie Secure 策略 (`auto` / `true` / `false`) |
| `ADS_WEB_LOGIN_MAX_ATTEMPTS` | `5` | 登录重试超限锁定阈值 |
| `ADS_WEB_LOGIN_LOCKOUT_MS` | `300000` (5分钟) | 登录锁定基础时长 |
| `ADS_PLANNER_CODEX_MODEL` | 未设置 | Advisor Lane 使用的专属 Codex 模型覆盖 |
| `ADS_PLANNER_SANDBOX_MODE` | `danger-full-access` | Advisor Lane 沙箱权限覆盖；非法值回退为 `workspace-write` |
| `ADS_SCHEDULER_MODEL` | 未设置 | Scheduler 执行定时 Prompt 时使用的模型覆盖 |
