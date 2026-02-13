# 设计概览（一句话）

把“理解消息/提炼信息”放到短生命周期的 `ingest agent` 里，把“状态机推进/定时调度/可观测任务编排”放到常驻的 `brain` 里，并以 `workspaceId` 为隔离边界。

---

# 总体架构

## 组件划分

- **Event Producers（事件源）**
  - Web planner（你在 Web 聊天输入）
  - Web worker / task queue（任务执行完成、失败、产生 patch/PR 等）
  - Telegram bot（你在 TG 输入、或系统回推通知）
- **Ingest skill（短任务）**
  - 由事件源在“一个对话/任务完成后”触发（post-hook）
  - 读取“本次交互产物 + bounded 状态切片”，输出结构化的 `IngestReport`
  - 作为一次性进程/一次性 agent 运行，结束即丢弃上下文
- **Brain（常驻）**
  - 接收 `IngestReport`，维护 per-workspace 状态机
  - 产生/调度 `BrainJob`（定时检查、外部跟踪、触发 worker、生成 draft）
  - 提供 Web 可观测的数据面（DB + WS broadcast）
- **Worker（执行面）**
  - 不强制引入新 worker：优先复用现有任务队列，把 brain job 映射为可见的 task（或新的 job UI）

## 关键设计原则

- **隔离**：以 `workspaceId` 为硬边界；同一 workspace 事件串行处理，跨 workspace 可并行。
- **bounded prompt**：任何 LLM 调用都只拿到“该 workspace 的最小状态切片 + 本次事件产物 + top-K 检索结果（可选）”。
- **可观测优先**：brain 的每一次“做事”都落到 DB（event/job/task），并通过 WebSocket/UI 展示。
- **幂等与可恢复**：每个外部动作（尤其是写操作）都要有去重键与审计。

---

# Ingest skill 设计

## 触发时机

### Web planner

一次对话完成后（assistant 已经回复，并且本轮可能产生了任务草稿/Spec/ADR/patch 等），触发 ingest。

### Web worker / task queue

任务进入 terminal 状态（completed/failed/cancelled）时触发 ingest，重点提炼：

- 执行的命令、退出码、错误摘要
- 产物：PR/Issue/link、生成的文件、diffstat
- 下一步建议：是否要重试、是否要创建 issue、是否要安排检查回调

### Telegram bot

一次消息处理完成后触发 ingest（可选），用于把 TG 消息映射成 brain 可追踪事件。

## Ingest skill 运行方式

建议实现为 `.agent/skills/brain-ingest/`：

- `SKILL.md`：定义输入/输出格式与运行约定
- `scripts/ingest.cjs`（或 `ingest.ts`）：收集本次事件工件、调用 LLM、输出 JSON

说明：脚本放在 `.agent/skills/<skill>/scripts/` 符合当前工程约束；不在项目根随意新增脚本。

## 输入（IngestInput）

Ingest 的输入由系统自动构造，不需要人类先筛选：

- `envelope`：事件外壳（路由/元数据）
- `artifacts`：本次交互产物（diffstat、links、command logs summary、created task ids、spec paths）
- `workspace_snapshot`（可选，且必须 bounded）：
  - `repo_ref`：当前 commit SHA / branch
  - `changed_files`：文件列表（不贴全文）
- `workspace_state_slice`：brain 为该 workspace 提供的“最小状态切片”（见后文）

## 输出（IngestReport）

Ingest 的输出必须是结构化 JSON，便于 brain 做幂等与调度。建议格式如下：

```json
{
  "schemaVersion": 1,
  "workspaceId": "string",
  "eventId": "string",
  "source": "web_planner|web_worker|telegram",
  "timestampMs": 0,
  "summary": "string",
  "externalRefs": {
    "julesSessionIds": ["string"],
    "githubPrNumbers": [0],
    "githubIssueNumbers": [0],
    "commitShas": ["string"]
  },
  "facts": [
    { "kind": "decision|todo|finding|link|error", "text": "string", "importance": 0, "ttlHours": 0 }
  ],
  "suggestedJobs": [
    {
      "type": "watch_jules_session|watch_github_pr|create_issue_draft|run_code_audit|notify",
      "runAtMs": 0,
      "dedupeKey": "string",
      "payload": {}
    }
  ],
  "confidence": 0
}
```

约束：

- `workspaceId` 必填，决定路由与隔离。
- `eventId` 必填，用于去重（例如哈希：`workspaceId + source + timestamp_bucket + taskId`）。
- `dedupeKey` 必填，brain 依赖它做 job 幂等。
- `facts[].ttlHours` 用于自动过期与压缩，控制状态膨胀。

---

# Brain 设计

## Brain 的“常驻”具体是什么意思

brain 是一个独立服务进程（类似现有 `ads-web` / `ads-telegram`），一直在线：

- 持续接收 ingest 输出（event queue）
- 持续跑定时调度（job scheduler）
- 在需要时触发 worker 执行后续动作

## Brain 作为 skill 的边界

brain 不是“一个 skill 就能替代”的短进程；但可以提供一个“brain 控制 skill”，用于运维与交互：

- `brainctl status`
- `brainctl list-jobs --workspace <id>`
- `brainctl trigger --job <id>`

skill 负责“控制接口”，进程本体常驻运行。

## Brain 如何处理不同项目来的消息

### 1) 全局入口：事件队列

brain 接收 `IngestReport` 并写入 `brain_events`（或直接由 ingest 写入 DB，brain 只消费）。

### 2) 路由：按 workspaceId 分发

- `workspaceId -> workspace_actor`
- 每个 actor 串行推进，避免同 workspace 并发写导致状态机错乱。

### 3) 幂等

- `eventId` 去重：重复 ingest 不产生重复状态更新
- `dedupeKey` 去重：重复建议 job 不产生重复 job

## Brain 内部持久化模型（建议）

最小集合（均带 `workspace_id`）：

- `brain_events`：原始 ingest report（可裁剪保留周期）
- `brain_memory_fragments`：事实/待办/决策碎片（带 `ttl`、`importance`、`tags`）
- `brain_external_trackers`：正在追踪的外部对象（jules session / PR / issue）
- `brain_jobs`：定时/异步动作队列（`run_at_ms`, `status`, `retry_count`, `last_error`, `dedupe_key`）
- `brain_actions`（可选）：需要人工确认的动作（issue create / pr close / branch delete）

## Brain 的调度（定时事件）怎么触发

建议用“持久化 job + 轮询 tick”实现最小可用：

- brain 主循环每 `N` 秒（例如 1~5s）扫描 `brain_jobs` 中 `status=pending AND run_at_ms <= now` 的 job，按并发上限取出执行。
- 执行时把 job 状态置为 `running`，写入 `started_at`。
- 成功：置 `completed`，写入产物引用（例如 PR/Issue link）。
- 失败：写 `last_error`，计算 `next_run_at_ms`（指数退避），`retry_count++`；超过上限置 `failed` 并通知。

这个方案的好处：

- 不依赖进程内 timer 的精确性（timer 只是触发轮询）
- 重启可恢复（DB 里还有 pending jobs）
- 可观测（Web 可以列出 jobs 与失败原因）

## 定时事件失败怎么办

- 失败写入 `brain_jobs.last_error`
- 退避：`backoff = min(maxBackoff, base * 2^retry_count)`
- 最大重试：例如 10 次
- 进入 `failed` 后：
  - 生成一个 `brain_actions`（需要人工处理）或发通知
  - 保留足够的诊断信息（失败阶段、外部命令输出摘要、时间）

---

# Worker 触发与“干预”机制（可观测性问题）

你提到的关键痛点是：brain 如果直接 `spawn` 一个后台进程跑完就退出，Web 侧看不到过程与结果。

因此建议 brain 的任何动作都以“可观测实体”存在，并且最好复用现有任务系统：

## 方案 A（推荐）：brain job -> ADS task

brain 遇到需要执行的动作时，不直接 spawn，而是创建一个 ADS `task`：

- task 的输入包含 `brainJobId`、`workspaceId`、payload（例如 `sessionId` / `prNumber`）
- worker 执行过程中，沿用现有 task message / status 流（Web 已经能展示）
- worker 结束后，触发 ingest，把结果回写 brain 状态机

优点：最少新 UI；天然可观测；已有队列/并发控制。

## 方案 B：brain 自己执行，但必须写进度

如果 brain 自己执行（例如调用 `gh`/`jules`），也必须：

- 将执行过程写入 `brain_jobs` 的 `log` 或 `brain_job_messages`
- 通过 WebSocket 推送增量

这比复用 task 系统更容易重复造轮子，建议先用方案 A。

---

# 最小状态切片（workspace_state_slice）长什么样

brain 给 ingest 提供的“最小上下文”不是对话全文，而是可控的结构化摘要：

```json
{
  "workspaceId": "string",
  "activeTrackers": [
    { "kind": "jules_session|github_pr|github_issue", "id": "string", "state": "string", "nextCheckAtMs": 0 }
  ],
  "openTodos": [
    { "id": "string", "text": "string", "importance": 0 }
  ],
  "recentFacts": [
    { "id": "string", "kind": "decision|finding|error|link", "text": "string" }
  ],
  "policy": {
    "issueWriteMode": "draft_only|auto",
    "notifyMode": "silent|telegram|web"
  }
}
```

这个切片由 brain 直接从 DB 读取并裁剪，不需要 LLM 先“再处理一遍代码/对话”。

---

# 风险与取舍

- **LLM 自治的边界**：自治的是 ingest 的“理解与提炼”，不是让 brain 维持一个无限长的 prompt。
- **成本控制**：每次 ingest 调用的输入必须 bounded；否则多项目会直接按 token 成本爆炸。
- **一致性**：per-workspace 串行 actor 能显著降低错乱风险，但会降低单 workspace 的吞吐；通常可接受。

