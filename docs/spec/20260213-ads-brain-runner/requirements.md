# 背景与目标

我们希望把 ADS 从“被动响应”（只有你在 Web/Telegram 发起对话时才会拉起一次性 agent）升级为“有控制回路的系统”：

- 你在 Web console 或 Telegram 里发起的对话/任务，可能会触发耗时外部流程（例如 Jules 分析代码、创建 PR）。
- 这些外部流程完成后，系统需要能**自动检查状态**、**发现产物（PR/Issue）**、**触发下一步动作（例如提 Issue、通知、排队执行后续任务）**。
- 同时要避免“上下文爆炸/串台”：多项目、多入口（planner/worker/tg）并行，不能因为一个常驻“大脑”把所有内容混到一个长对话里导致错乱。

本 spec 讨论一个总线化架构：`ingest`（短任务）把对话/任务产物提炼为结构化事件；`brain`（常驻）维护每个 workspace 的状态机与定时调度；必要时触发 `worker` 执行后续动作，并确保 Web 可观测。

## 非目标（本阶段不做或不承诺）

- 不在本阶段实现“全自动修 bug 并直接修改 main / 自动合并”。
- 不要求 `brain` 维护一个永不终止的 LLM 长对话 thread（这是导致串台的主要风险源）。
- 不要求 `ingest` 每次全量读仓库代码；优先用可控的“产物/差分摘要”。

# 术语

- **Workspace**：一个项目/仓库的工作区（建议用 `workspaceRoot` 作为稳定键）。
- **Planner/Worker**：ADS 现有的对话入口与执行队列（web planner/worker + tg bot）。
- **Ingest**：对“刚发生的对话/任务结果”做结构化提炼的过程（短生命周期，bounded prompt）。
- **Brain**：常驻进程，维护每个 workspace 的状态机/调度器，接收 ingest 输出并触发后续动作。
- **Job**：brain 内部的“待执行动作”（定时检查、拉取外部状态、生成 issue draft、触发 worker 等）。
- **Event**：来自 planner/worker/tg 的事件；或来自 ingest 的结构化报告。

# 需求（Requirements）

## R1. 多入口事件统一接入

- Web planner、Web worker（任务队列）、Telegram bot 在一次交互完成后，应能产生一个“事件”（event），进入同一个处理链路。
- 事件必须携带足够的**路由信息**，至少包括：`workspaceId`/`workspaceRoot`、来源（planner/worker/tg）、相关的 `conversationId`/`taskId`/`jobId`（如果存在）。

## R2. 上下文隔离，避免串台

- brain 必须保证不同 workspace 的状态与决策互不污染。
- ingest 必须是 bounded prompt：只使用“该 workspace 的最小状态切片 + 本次事件产物”，不能自动把所有历史对话全文塞进同一个上下文。

## R3. 可观测性（Web 可见）

- brain 触发的动作（检查 Jules session、检查 PR、生成 issue、触发后续 worker）必须在 Web 上可见：
  - 至少能看到：当前正在追踪什么、下一次检查时间、失败原因与重试次数、最终产物链接。
- 不允许出现“brain 在后台 spawn 了东西跑完了，但 Web 用户完全看不到发生了什么”的黑盒体验。

## R4. 定时/回调机制

- brain 可以为每个 workspace 安排定时 job（例如每 10 分钟检查一次某个 Jules session 是否完成；或每天做一次 code review）。
- 定时 job 必须具备：
  - 持久化（重启 brain 不丢）
  - 幂等（重复触发不导致重复副作用）
  - 失败可恢复（重试策略、退避、最大次数、最终失败态）

## R5. 外部产物跟踪

- brain 能跟踪外部系统产物：至少包括 Jules session、GitHub PR、GitHub Issue。
- 可从一个外部标识推导/定位另一个外部标识（例如从 `sessionId` 定位 PR）。

## R6. 人工介入（可选但强烈建议）

对于高风险的写操作（例如创建 Issue、关闭 PR、删除远端分支），需要提供一个“gate”：

- 默认先生成 draft（或标记为 `pending_action`），让用户在 Web/Telegram 确认后再执行。
- 如用户明确选择自动执行，则可以配置为自动执行，但仍需幂等与审计日志。

# 验收标准（Acceptance Criteria）

- 系统在同时配置多个项目时，事件不会串台：同一条事件只会影响对应 `workspaceId` 的状态。
- 任意一次 ingest 输出都能在 Web 中查到对应记录（event/job/task 其中之一）。
- brain 重启后仍能继续推进：到点会再次检查外部状态并触发后续动作。
- 所有定时 job 支持失败重试并有可见的失败信息。

