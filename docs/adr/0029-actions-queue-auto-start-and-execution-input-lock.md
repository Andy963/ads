# ADR 0029: Actions 队列派发自动启动与执行期输入锁定

## Status

Accepted

## Context

#419 暴露了 Actions 队列在人机协作上的三处断裂：

- 派发到队列的任务停留在 `queued`，必须由用户在界面上手动点击「启动执行」，
  Acopilot 与 Developer 之间因此存在一次纯粹的人工中转，队列本身并不消费任务。
- Actions 输入框在任务执行期间保持可编辑。Actions lane 与队列任务共享同一条会话，
  执行期间的用户输入会触发 abort 信号，直接杀死正在运行的 Developer 轮次。
  `docs/acopilot-actions-spec.md` §5.1 原先的「意图区分规则」把执行期输入定义为
  实时转向指令（Steering Context），但现有执行链路并没有安全的转向通道，该规则
  描述的实际上是一个破坏性路径。
- 执行失败只在 `action_jobs.error_message` 落库，聊天流里看不到失败阶段与详情；
  `action_rework` / `action_blocked` 以 role `status` 记录，实时仅落到易失的
  lane 横幅，重连后又被历史回放过滤丢弃。

队列本身已有串行保障：`evaluateQueue` 通过 `processingProjects` 防重入，
Three-Point Checkout Gate（终态门禁、工作区净空门禁、基线对齐门禁）保证同一
项目同一时间只有一个任务占用主工作区；失败经由 ADR 0015 的有界重作状态机
（上限 2 次，超限置 `blocked`）收敛。

## Decision

### 派发即自动启动

`LaneDispatchBus.dispatchJob` 在落库后同步返回之前，通过 `queueMicrotask`
以 fire-and-forget 方式触发 `evaluateQueue(projectId, repoPath, authUserId)`：

- 自动启动**必须**能解析出 `repoPath`。当前三个生产调用方（HTTP 路由
  `POST /api/actions/dispatch`、`dispatch_action_job` 原生工具、技能指令工具）
  都已携带 `repoPath`；无法解析时仅输出 `console.warn` 并保持任务 `queued`，
  不抛错、不阻塞派发响应。
- 重入安全沿用既有机制，不引入新的调度器：`processingProjects` 防止并发评估，
  Three-Point Gate 防止在已有活跃任务或脏工作区上检出新分支。忙碌时新任务保持
  `queued`，由在途任务收尾（`executeDeterministicMerge`、`cancelJob` 等）处的
  既有 `evaluateQueue` 触发点推进，而不是由派发方轮询。
- 「启动执行」按钮与 `POST /api/actions/queue/start` **保留**，作为因门禁或
  runtime preflight 未通过而滞留 `queued` 的任务的人工恢复通道。自动启动取代的
  是常规路径上的人工中转，不是这条逃生口。

### 执行期输入锁定

任务处于 `running` / `verifying` / `reviewing` / `waiting_merge` 期间，Actions
lane 的输入框、发送与重试入口被**硬锁定**：

- 锁定由客户端计算属性实现：运行期 `inputLocked` 与「当前项目存在执行中任务」
  取或（`client/src/lib/actionJobs.ts` 的 `hasLockingActionJob`）；`actionJobs`
  已由 `loadActionJobs` 限定在当前项目。
- 除禁用输入框外，`@send` 与 `@retry-message` 处理器各自带守卫，确保锁定真正
  阻止发送而非仅置灰 textarea；模型选择器同步锁定，避免执行中向共享会话发送
  `model_override`。
- 解锁是自动的：任务跃迁到 `completed` / `failed` / `blocked` / `cancelled`
  后，`action_job_updated` 广播（辅以活跃期 2s 轮询）刷新任务列表，计算属性
  随之解除锁定。`blocked` 属于「等待人工处理」语义，需要用户阅读失败信息并
  决策，因此不锁定。

### 取代关系

本 ADR **取代 (Supersedes)** `docs/acopilot-actions-spec.md` §5.1 的「意图区分
规则」（执行期输入作为 Steering Context）。该节已改写为执行期输入锁定规则；
在存在安全的会话内转向通道之前，执行期输入的唯一定义是「禁止」。原规则所
期望的转向能力如有需要，须以不触发 abort 的独立机制重新设计，并另行记录 ADR。

失败与取消的诊断信息随之进入聊天流：`failed` / `blocked` / `cancelled` 跃迁
以及 runtime preflight 失败均以 role `assistant` 经 `recordActionMessage` 写入
历史并广播，实时渲染为聊天气泡且在重连后保留，弥补原先 role `status` 消息
「横幅易失、回放丢弃」的缺口。

## Consequences

### 正面

- 队列闭环：派发 → 执行 → 验证 → 评审 → 合并全程无人工中转，Acopilot 派发的
  任务不再依赖用户点击。
- 执行中的 Developer 轮次不再被共享会话里的用户输入意外 abort；锁定语义与
  任务状态机严格对齐（执行期锁、终态/人工处理态解锁）。
- 失败阶段与详情直接出现在 Actions 聊天流并持久化，刷新/重连后仍可追溯。
- 未新增调度原语：自动启动复用 `evaluateQueue` 及其全部既有防护，行为与手动
  触发完全一致。

### 影响与成本

- 执行期间用户无法通过输入框介入任务；唯一的介入手段是「取消」按钮。这是
  刻意取舍：在安全的转向通道出现前，可输入即是可破坏。
- 因门禁或 preflight 失败而滞留 `queued` 的任务不会被自动重试，需要人工经
  「启动执行」恢复或等待下一次派发触发评估。自动重试策略如有需要另行决策。
- 锁定依赖客户端任务列表的新鲜度；项目切换后的首个拉取窗口内沿用上一份列表
  （fail-closed，偏向锁定），可接受。
- `dispatchJob` 在缺少 `repoPath` 时多一条 `console.warn`；生产调用方均已携带，
  该告警只应出现在测试或未来的新调用方中。
