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
  - 集成 **Task Bundle Drafts（任务草稿箱）**：查看 Advisor 生成的结构化任务束，支持在线编辑子任务与一键审批入队。
- **Advisor (规划 Lane)**：
  - 默认对话 Lane，用于方案讨论、代码架构设计与任务拆解。
  - 讨论完成后将一个稳定 work-item key 的结论写入 `docs/issue/<key>/`，再在 `docs/spec/<key>/` 生成 Worker 规格。
  - Task Bundle 必须同时携带匹配的 `issueRef` / `specRef` 目录，并且一个 spec 只生成一个 task；服务端会在批准时拒绝单文件引用、缺目录或 key 不匹配的 bundle。
  - 支持输出 `ads-schedule` 定时指令或生成 Task Bundle 任务草稿。
- **Worker (执行 Lane)**：
  - 专注于代码执行、命令运行与文件修改的执行 Lane。
  - 执行任务时先读取批准时固定的 issue/spec 快照；spec 是执行真源，issue 只提供讨论背景。
  - 实时展示任务阶段 trace（如 `[analysis]`、`[tool]`、`[editing]`）与命令执行输出（最新命令预览），自动收起长文本输出。
  - Plan 卡片按单轮逻辑计划合并 provider 更新，并在任务完成与历史重连时保持唯一且状态一致。

### 2. Provider CLI 与全局模型配置 (Provider & Models)
- **多 Provider CLI 接入**：
  - 原生支持 **Codex CLI**（OpenAI Codex）、**Claude Code**（Anthropic Claude）与 **Droid CLI**（Factory Droid）。
  - 左侧导航可切换 Provider，右侧维护各 Provider 的模型列表。
- **模型管理**：
  - 在线启用/停用模型、设置默认模型、编辑与新增模型。
  - 输入框模型选择器严格联动：仅展示当前 Agent 兼容且已启用的模型，切换 Agent 时自动恢复对应兼容偏好。
  - 所有模型配置持久化于全局 SQLite 状态库 (`state.db`)。

### 3. 全局规则系统 (Global Rules)
- 跨项目、跨 Channel（Web Console / Telegram Bot）以及跨 Agent（Codex / Claude / Droid）统一生效的规则引擎。
- 规则分为四种级别：`advisory`（建议）、`required`（必须遵守）、`approval_required`（需审批）、`blocked`（阻断）。
- 支持在线规则编辑、启用/停用、匹配模式过滤（针对特定 Agent、工具或路径）。
- 提供 **注入预览 (Preview)** 与 **规则测试面板 (Test Playground)**，修改后实时保存至数据库，下一轮对话即时注入 `<global_rules>` 上下文生效，无需重启服务。

### 4. 原生会话恢复与历史管理 (Session Resume)
- 点击工具栏 **「历史会话」** 打开恢复选择器。
- 自动扫描并展示当前项目工作区下所有的原生 Provider 会话（标题、更新时间、轮数统计）。
- 原生恢复：直接按 CLI 底层 session 续接，不重复注入历史文本，保留完整的 Token 上下文与缓存状态。
- 会话文件健康判定：断线或重连时若会话文件存在则原生恢复，缺失时平滑降级并友好提示。

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
2. **三 Tab 扁平导航**：移动端顶栏按 `Task | Advisor | Worker` 排布，默认聚焦 Advisor。
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
| `TASK_QUEUE_ENABLED` | `true` | 是否开启后台任务队列 |
| `TASK_QUEUE_AUTO_START` | `false` | 服务启动后是否自动开始运行任务队列 |
| `TASK_QUEUE_DEFAULT_MODEL` | 未设置 | 任务队列默认执行模型 |
