# Design: Brain + Ingest for Bub (Telegram group-ready)

## 一句话设计

把“理解消息/提炼意图”放到短生命周期的 ingest 调用里，把“隔离路由/状态机推进/调度/幂等 gate”放到常驻 brain 里；以 `chat`/`thread`/`user` 三层 scope 同时实现“关联”与“隔离”。

## 1. 总体架构

### 1.1 数据流（Telegram）

```text
Telegram Update
  -> TelegramChannel (always-on)
  -> MessageBus
  -> ChannelManager
     -> BrainRouter
         -> (optional) IngestRunner (bounded LLM)
         -> BrainService (state machine + scheduler + gate)
             -> decide: reply now / enqueue job / ignore
             -> if reply now: call AppRuntime.handle_input(session_id, payload)
             -> if enqueue job: persist BrainJob
     -> OutboundMessage -> TelegramChannel.send
```

### 1.2 组件拆分

- **BrainRouter**
  - 入口适配层：把 `InboundMessage` 转成 `EventEnvelope`
  - 计算 scope：`chat_id` / `thread_id` / `sender_id`
  - 调用 ingest（可选）并把 `IngestReport` 投递给 brain
  - 根据 brain 决策触发“立即回复”或“创建 job”

- **IngestRunner**
  - 输入：`EventEnvelope` + bounded 状态切片（shared/thread/user）
  - 输出：`IngestReport`（结构化 JSON）
  - 失败/低置信度时必须允许回退（compat path）

- **BrainService**
  - 维护 per-scope 的 state
  - 提供 job store + scheduler
  - 提供 action gate（draft/approve/execute）与审计

- **Execution**
  - 立即回复：复用现有 `AppRuntime.handle_input` + `AgentLoop`
  - 异步 job：两种实现路径
    1) 同进程调用 `AppRuntime.handle_input`（最少上下文切换）
    2) 通过子进程调用 `bub run --session-id ...`（更强隔离，便于运维）

## 2. Scope 模型：关联与隔离如何同时成立

### 2.1 Key 设计

建议引入三个 key（都是字符串，可哈希）：

- `chat_key = "telegram:<chat_id>"`
- `thread_key = "telegram:<chat_id>:thread:<root_message_id>"`
- `user_key = "telegram:<chat_id>:user:<sender_id>"`

规则：

1. **关联优先靠 thread_key**
   - reply chain 内不同用户的消息共享同一 `thread_key`
2. **隔离靠 user_key**
   - 个人偏好/私有任务写入 `user_key`
3. **共享事实靠 chat_key**
   - 群内统一约定、全局 TODO、公告类摘要写入 `chat_key`

### 2.2 root_message_id 的推导

在 Telegram update 中：

- 若消息是 reply：`root_message_id = reply_to_message.message_id`（可继续向上追溯，但最小可用直接用 reply 的 message_id）
- 若消息不是 reply：`root_message_id = message.message_id`（每条非 reply 的消息自然成为新 thread）

### 2.3 session_id 与 tape 的策略

为了实现 bounded context，推荐把 `thread_key` 映射为 `session_id`，让每个 thread 使用独立 tape：

- `session_id = thread_key`（推荐）
- `chat_key` 与 `user_key` 不直接进入模型 tape，而是以“状态切片摘要”注入到 prompt（或写入专门的 brain store）

这样 thread 的 tape 天然 bounded；跨 thread 的关联通过 chat/user 的结构化摘要实现，而不是把整个群聊 tape 塞回模型。

兼容模式：

- 允许配置 `BUB_BRAIN_SESSION_STRATEGY=chat`：仍沿用现有 `session_id = chat_key`（迁移期）

## 3. Ingest 设计

### 3.1 输入（IngestInput）

```json
{
  "schemaVersion": 1,
  "envelope": {
    "event_id": "string",
    "channel": "telegram",
    "chat_id": "string",
    "sender_id": "string",
    "message_id": "int",
    "reply_to_message_id": "int|null",
    "received_at_ms": 0,
    "session_id_candidate": "string"
  },
  "message": {
    "text": "string",
    "metadata": {}
  },
  "state_slice": {
    "chat_summary": "string",
    "thread_summary": "string",
    "user_summary": "string",
    "open_actions": [
      { "id": "string", "kind": "issue_create|announce|other", "status": "pending_approval" }
    ]
  }
}
```

约束：

- `state_slice` 必须严格限长（例如每段 summary 2k chars，上限可配置）。
- 不携带密钥与敏感配置。

### 3.2 输出（IngestReport）

```json
{
  "schemaVersion": 1,
  "event_id": "string",
  "chat_key": "string",
  "thread_key": "string",
  "user_key": "string",
  "intent": "reply|task|status|chatter|ignore",
  "needs_reply": true,
  "reply_mode": "immediate|deferred",
  "priority": 0,
  "facts": [
    { "kind": "decision|todo|link|error", "text": "string", "importance": 0, "ttl_hours": 0 }
  ],
  "suggested_jobs": [
    { "type": "notify|watch_external|run_task", "run_at_ms": 0, "dedupe_key": "string", "payload": {} }
  ],
  "suggested_actions": [
    { "kind": "issue_create|announce", "dedupe_key": "string", "draft": { "title": "string", "body": "string" } }
  ],
  "confidence": 0.0
}
```

brain 不需要相信 ingest 的一切：

- `facts` 可直接入库（但带 TTL/importance）
- `suggested_actions` 默认进入 gate（draft-only）
- `suggested_jobs` 必须按 dedupe_key 去重

## 4. Brain 设计

### 4.1 持久化模型（建议 SQLite）

最小集合：

- `brain_events`：`event_id`, envelope, ingest_report, created_at
- `brain_jobs`：`job_id`, `dedupe_key`, `scope_key`, `type`, `payload`, `status`, `run_at_ms`, `lease_until_ms`, `retry_count`, `last_error`
- `brain_actions`：`action_id`, `dedupe_key`, `scope_key`, `kind`, `draft_json`, `status(pending_approval|approved|executed|rejected)`, audit fields
- `brain_facts`：碎片化事实，带 TTL 与归属 scope

为什么不用纯 JSON 文件：

- 需要原子 claim/lease
- 需要索引与查询（list jobs/actions）
- 需要在崩溃恢复时做一致性修复（回收 lease）

### 4.2 Job claim/lease

原则：

- 任何 job 执行前必须先 claim（事务内从 `pending` -> `running`，写入 `lease_until_ms`）。
- brain tick 扫描时只取 `pending AND run_at_ms <= now`。
- 如果 `running AND lease_until_ms < now`，可回收为 `pending` 或标记 `failed`（由策略决定）。

### 4.3 写操作 gate

动作分类：

- **read-only jobs**：例如检查外部状态、计算摘要，可自动执行。
- **write actions**：例如创建 issue、发送公告、执行 destructive shell，默认 `pending_approval`。

批准渠道：

- CLI：`,brain.actions` / `,brain.approve <id>`
- Telegram：在群里回复一个专用命令（例如 `/bub approve <id>`）或私聊审批

执行时仍要幂等：

- 优先在外部系统中写入 `dedupe_key` 标记（例如 issue body 中嵌入一个 token）
- 执行前尝试查询是否已存在相同 token 的对象

## 5. 与现有 Bub SDK/Loop 的集成方式

### 5.1 同进程集成（推荐先做）

- 在 `ChannelManager._process_inbound` 增加 `BrainRouter`：
  - 生成 envelope
  - 计算 thread_key（需要 TelegramChannel 补充 reply_to_message_id）
  - 调用 ingest（可配置开关）
  - 根据 brain 决策：
    - `needs_reply`：调用 `runtime.handle_input(session_id, payload)`
    - `deferred`：创建 job，立即回复一个短 ack（可选）

### 5.2 独立进程集成（运维隔离）

brain 执行 job 时，不直接 import runtime，而是：

```text
python -m bub.cli.app run --session-id <thread_key> "<job prompt>"
```

优点：

- 进程级隔离，避免 brain 内存泄漏影响主服务
- 与现有 schedule 工具一致（Bub 目前已经用 subprocess 方式触发 run）

缺点：

- 进程开销与启动延迟更高

## 6. 风险与对策

- **事件风暴**：listen-all 群聊会产生大量事件
  - 对策：先用轻量非 LLM gate（mention/reply/command），再 ingest；并对 ingest 做速率限制与采样
- **串台/误路由**：thread_key 推导错误
  - 对策：优先 reply chain；无法推导时降级到 chat_key；并在 ingest_report 中记录置信度
- **写操作误执行**：
  - 对策：默认 draft-only；auto 模式必须显式配置；外部写入必须 dedupe
- **bounded context 不生效**：
  - 对策：强制 per-thread tape；chat/user 摘要只作为注入块，不作为全量 tape

