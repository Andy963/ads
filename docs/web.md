# ADS Web Console

ADS Web Console 是一个轻量级、响应式且功能完备的 AI 辅助编程与任务编排浏览器端界面。

---

## 核心功能与工作流

### 1. 工作区与三 Tab 结构 (Workspace Tabs)
Web Console 将对话与任务流组织为三大工作区：
- **Task (任务区)**：
  - 展示当前项目的待处理、运行中与已完成任务看板。
  - 支持直接创建任务（支持多模态图片附件、语音输入与 Goal Mode 目标模式）。
  - 支持任务拖拽排序、批量调整优先级、立即执行与删除。
  - 任务编辑在列表刷新或保存失败时保持状态一致；保存失败会保留编辑内容以便重试，任务已消失时会清理编辑状态。
  - 集成 **Task Bundle Drafts（任务草稿箱）**：查看 Advisor 生成的结构化任务束，支持在线编辑子任务与一键审批入队。
- **Advisor (规划 Lane)**：
  - 默认对话 Lane，用于方案讨论、代码架构设计与任务拆解。
  - Task Bundle 可直接引用 GitHub Issue/PR URL，或只携带自包含的任务 prompt；不要求先创建本地 `docs/issue/` 与 `docs/spec/` 目录，审批也不以这两个目录为前提。
  - 显式使用本地 `/draft` 快照时，仍可携带匹配的 `issueRef` / `specRef` 目录并在批准时固定内容；本地快照是兼容能力，不是 GitHub-native 流程的前置条件。
  - 支持输出 `ads-schedule` 定时指令或生成 Task Bundle 任务草稿。
  - 任务带有 `development`（开发）、`review`（审核）和 `rework`（返工）分类；待执行任务按 `priority` 降序、队列顺序升序领取。
  - 开发或返工任务完成并在结果中报告 GitHub PR 后，队列会幂等创建 P10 审核任务。审核结果使用 `REVIEW_STATUS: approved|rejected` 标记；拒绝且包含反馈时自动创建 P50 返工任务。
- **Worker (执行 Lane)**：
  - 专注于代码执行、命令运行与文件修改的执行 Lane。
  - 若任务带有本地 issue/spec 快照，执行时先读取批准时固定的内容；没有快照时直接以任务 prompt 及其 GitHub 引用作为执行依据。
  - 实时展示任务阶段 trace（如 `[analysis]`、`[tool]`、`[editing]`）与命令执行输出（最新命令预览），阶段 trace 只显示简洁语义标签；重复的 reasoning 生命周期噪声不会写入历史 thought；文件路径和变更明细由 Patch 卡片展示，自动收起长文本输出。
  - Plan 卡片按单轮逻辑计划合并 provider 更新，并在任务完成与历史重连时保持唯一且状态一致。

### 2. Provider CLI 与全局模型配置 (Provider & Models)
- **多 Provider CLI 接入**：
  - 原生支持 **Codex CLI**（OpenAI Codex）与 **Claude Code**（Anthropic Claude）。
  - 左侧导航可切换 Provider，右侧维护各 Provider 的模型列表。
- **模型管理**：
  - 在线启用/停用模型、按 CLI 设置默认模型、编辑与新增模型；Codex 与 Claude 的默认模型彼此独立。
  - 在模型管理顶部单独选择 Reviewer 模型；下拉只展示启用的具体模型，审核任务不会继承 Worker 模型。未配置 Reviewer 模型时，任务完成后的审核子任务不会创建，并会在任务事件中报告配置错误。
  - 输入框模型选择器严格联动：仅展示当前 Agent 兼容且已启用的模型，切换 Agent 时自动恢复对应兼容偏好。页面加载或模型列表刷新不会覆盖已有的自定义模型选择。
  - 所有模型配置和 Reviewer 模型选择持久化于全局 SQLite 状态库 (`state.db`)。

### 2.1 流式回复增量

WebSocket 流式回复按 Provider 的消息 `itemId` 隔离累计文本；多个 agent message、工具调用和 reasoning item 交错时，不会把其他 item 的完整快照重复追加到当前回复。前端还会忽略已接收的重复累计前缀，作为传输异常时的最后一道保护。

### 3. 全局规则系统 (Global Rules)
- 跨项目、跨 Channel（Web Console / Telegram Bot）以及跨 Agent（Codex / Claude）统一生效的规则引擎。
- 规则分为四种级别：`advisory`（建议）、`required`（必须遵守）、`approval_required`（需审批）、`blocked`（阻断）。
- 支持在线规则编辑、启用/停用、匹配模式过滤（针对特定 Agent、工具或路径）。
- 提供 **注入预览 (Preview)** 与 **规则测试面板 (Test Playground)**，修改后实时保存至数据库，下一轮对话即时注入 `<global_rules>` 上下文生效，无需重启服务。

### 4. 原生会话恢复与历史管理 (Session Resume)
- 点击工具栏 **「历史会话」** 打开恢复选择器。
- 自动扫描并展示当前项目工作区下所有的原生 Provider 会话（标题、更新时间、轮数统计）。
- 原生恢复：直接按 CLI 底层 session 续接，不重复注入历史文本，保留完整的 Token 上下文与缓存状态。
- 会话文件健康判定：断线或重连时若会话文件存在则原生恢复，缺失时平滑降级并友好提示。
- 新建聊天会话时，在线 WebSocket 通过原连接内协议切换 session；连接状态保持在线，离线时自动回退到完整重连。
- 重连或后端重启后，只要持久化历史存在就会发送历史快照；即使后端上下文暂时是 fresh，客户端也保留本地聊天记录，只有显式线程重置才会清空历史。
- Bootstrap 等待期间提交的提示会进入持久 outbox，待历史同步完成后继续发送；若历史帧丢失，5 秒兜底会解除等待锁，避免 Composer 永久冻结。
- 清空或新建会话不会删除 Composer 中尚未提交的草稿文本；每轮消息中的 Plan、实时活动、Thought、Execute 与 Patch 卡片按稳定语义顺序展示，已完成的阶段 trace 会在历史重放时保留为可折叠 Thought 卡片。
- Worker 与 Advisor 的清空操作默认只作用于发起操作的 chat lane；跨 lane 清理必须显式请求 shared scope，且 session reset 广播会校验来源 lane。

### 5. 多模态与文件联动
- **多模态图片附件**：支持拖拽、粘贴与上传图片，MainChat 与任务创建表单均提供紧凑缩略图预览与大图查看器。
- **语音输入 (Voice Input)**：内置基于 Whisper / Groq 的语音转写，点击麦克风录音即可实时转为 Prompt 输入文本。
- **文件与行号跳转预览 (File Preview Modal)**：
  - 对话中输出的代码路径或链接（如 `src/app.ts#L42`）自动渲染为高亮交互链接。
  - 点击即可弹出文件预览模态框，支持语法高亮、精准行号高亮、相邻窗口分页与一键复制。

---

## 移动端适配 (Mobile Experience)

Web Console 经过专门的移动端交互优化：
1. **抽屉式导航 (Drawer Navigation)**：左上角汉堡菜单可无缝滑出抽屉，按 **项目 (Projects)**、**规则 (Rules)**、**Provider** 进行全局模块切换。
2. **三 Tab 扁平导航**：移动端顶栏按 `Task | Advisor | Worker` 排布；首次使用或项目没有记录时聚焦 Advisor，之后按项目恢复上次打开的 Tab。
3. **独立上下文菜单 (Context Actions)**：右上角根据当前激活模块提供专属操作（如新增任务、恢复会话、新建会话、新增规则、刷新模型列表等），语言与操作深度统一。
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
| `TASK_QUEUE_ENABLED` | `true` | 是否开启后台任务队列 |
| `TASK_QUEUE_AUTO_START` | `false` | 服务启动后是否自动开始运行任务队列 |
| `TASK_QUEUE_DEFAULT_MODEL` | 未设置 | 任务队列默认执行模型 |
