# Requirements: Brain + Ingest for Bub (Telegram group-ready)

## 背景

Bub 当前的运行形态是“输入到来 -> 进入 session 的 deterministic loop -> 直接产出回复/命令（或工具调用）”，并把行为记录在 append-only tape 中。

这套形态在以下场景下会遇到系统性瓶颈：

1. **群聊输入流是持续的**：消息到达是 event loop 驱动，系统需要长期在线处理，而不是“人主动发起一次会话”。
2. **群聊存在多线程、多用户关联**：同一 chat 内不同用户会在同一话题链路（reply chain / topic）中交替发言，既需要“关联”也需要“隔离”。
3. **异步外部流程需要控制回路**：例如定时提醒、外部状态轮询（PR/Issue/CI）、失败重试、去重与可观测审计。
4. **写操作的风险与幂等**：对外部系统（GitHub/Telegram）或本地工作区产生副作用的操作，需要 gate、审计与幂等，避免重复执行与误操作。

本 spec 引入两类新概念：

- **Ingest**：短生命周期、bounded 的“提炼/分类”过程，把输入与产物转换为结构化事件报告。
- **Brain**：常驻的控制面（state machine + scheduler + gate），负责路由、去重、调度与可观测，不要求维持一个永不终止的 LLM 对话 thread。

## 术语

- **EventEnvelope**：事件外壳，携带路由与元数据（channel/chat/user/message id 等）。
- **IngestReport**：ingest 输出的结构化 JSON（intent、thread key、建议 job、外部引用等）。
- **BrainJob**：brain 内部的“待执行动作”（可定时、可重试、可去重）。
- **ActionDraft / Gate**：写操作的草稿与审批机制。
- **Scope**：隔离边界与关联边界，至少包括 `chat`、`thread`、`user`。

## 目标

### R1. 群聊可用的事件接入与路由

- Telegram inbound message 进入系统时，必须先生成 `EventEnvelope`，并可选触发 ingest。
- 系统必须能识别消息所属的 `scope`：
  - `chat`：整个群聊共享上下文
  - `thread`：基于 reply chain / topic 的话题上下文（推荐作为主要“关联单元”）
  - `user`：个人偏好/私有任务（用于隔离）
- 路由必须保证：同一 `thread` 内不同用户的消息不会被错误隔离到不同上下文。

### R2. Bounded prompt（受控上下文）与成本控制

- ingest 调用必须是 bounded：
  - 输入只允许包含：本次消息 + 受控的状态切片（shared/thread/user 的摘要或 top-K 片段）
  - 禁止把整个 chat 的历史 tape 全量塞回模型（避免 token 爆炸）
- 需要提供策略：
  - 在“高噪声群聊”中允许 `needs_reply=false`（不回复但可记录事实/指标）
  - 对 ingest 失败/低置信度时可以回退到现有直接 loop（兼容模式）

### R3. Always-on brain，但不要求 always-on LLM thread

- brain 作为控制面服务常驻运行，负责：
  - 事件去重（按 event id）
  - job 去重（按 dedupe key）
  - job 调度、claim/lease、退避重试
  - 写操作 gate、审计与执行追踪
- LLM 调用（ingest/respond）是短调用、按需触发。

### R4. 写操作更安全（Gate + Idempotency + Audit）

- 对所有可能产生外部副作用的操作（例如：发送群公告、创建 GitHub Issue、写文件并 commit）：
  - 默认生成 `ActionDraft`，并进入 `pending_approval`
  - 只有在用户明确批准或策略允许 auto 时才会执行
- 对执行动作必须提供：
  - `dedupe_key`：稳定去重键
  - `audit log`：可追溯到触发事件、审批人、执行时间、外部返回的引用（issue/pr link）
  - `retry policy`：失败可重试，且重复执行不会造成重复副作用

### R5. 可观测性（不黑盒）

- 必须能够查询（CLI 或简单 HTTP）：
  - 最近的 `EventEnvelope` / `IngestReport`
  - 当前 `BrainJob` 列表与状态（pending/running/completed/failed）
  - 待审批的 `ActionDraft` 列表与详情
- 对 Telegram 场景：
  - 允许把“需要人工 gate 的 action”发回群里（或私聊）提示

### R6. 与现有 Bub 架构兼容

- 不破坏 Bub 现有确定性路由语义（逗号命令边界、失败回退结构块等）。
- 不要求重写 `AgentLoop` / `ModelRunner`；以“在 channel manager / runtime 边界插入 brain/ingest”方式集成。
- brain/ingest 可选择：
  - 作为 Bub 内部模块（同进程）
  - 或独立进程/服务，通过 `bub run` / `bub ingest` 等 CLI/HTTP 触发（推荐保留这种可选模式用于运维隔离）

## 非目标

- 不追求“一个永不终止的 LLM 大脑对话 thread”承载所有记忆与决策。
- 不承诺在本阶段实现 GitHub 全量自动化（自动 merge / 自动关闭 PR 等）。
- 不承诺把群聊里所有闲聊都纳入语义理解；默认应有 attention budget。

## 约束

- 运行语言与约束遵循 repo：Python 3.12+，Ruff/mypy/pytest。
- 任何新持久化状态必须可迁移、可备份，且默认不包含敏感信息。
- 不能在日志或存储中落明文密钥。

## 验收标准（最小可用）

1. Telegram 群聊中，reply chain 内多用户交替发言，系统能将它们路由到同一 `thread` 上下文。
2. 可配置 “listen-all” 模式：群内所有文本先 ingest，再决定是否回复；无关消息不回复但可落事件。
3. brain 重启后：
   - 未完成的 jobs 不丢
   - running job 可被 lease 超时回收或标记失败
4. 写操作默认 gate：
   - 创建 Issue / 发送群公告等先生成 draft
   - 未批准不会执行
   - 批准后执行一次且可追溯

## 验证方式（命令）

```bash
uv run ruff check .
uv run mypy
uv run pytest -q
just docs-test
```

