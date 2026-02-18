# Implementation: Brain + Ingest for Bub (Telegram group-ready)

## 0. 范围与落地策略

本实现以“可渐进集成”为原则：

- 默认不改变 Bub 现有行为：不开启 brain/ingest 时，Telegram/CLI 仍直接进入现有 loop。
- 开启后先实现“事件落库 + 线程路由 + 可查询”，再实现 jobs/actions。

## 1. Phase 1：事件落库 + ingest（只读，不调度）

### 1.1 新增模块与目录（建议）

```text
src/bub/brain/
  models.py            # EventEnvelope/IngestReport/BrainJob/BrainAction dataclasses + schema validation
  store.py             # SQLite store (events/jobs/actions/facts)
  ingest.py            # IngestRunner (bounded LLM) + prompt templates
  router.py            # BrainRouter: InboundMessage -> decisions
  service.py           # BrainService: apply ingest report -> persist state (no scheduling yet)
```

### 1.2 Telegram metadata 增强

目标：为 thread_key 推导提供必要字段。

- 在 `/home/andy/bub/src/bub/channels/telegram.py` 的 `_on_text` 中补充 metadata：
  - `reply_to_message_id`（if any）
  - `chat_type`（private/group/supergroup）
  - `bot_username`（optional）

### 1.3 ChannelManager 插入 BrainRouter

在 `/home/andy/bub/src/bub/channels/manager.py` 中将 `_process_inbound` 改为：

1) `envelope = BrainRouter.build_envelope(message)`
2) `decision = await BrainRouter.handle(envelope, message)`
3) 若 `decision.reply_text`：发送 OutboundMessage
4) 若 `decision.forward_to_loop`：调用 `runtime.handle_input(decision.session_id, decision.loop_payload)`

Phase 1 中，`decision` 的最小版本可以是：

- 默认 `forward_to_loop=True`（保持现有行为）
- 同时把 `EventEnvelope` 与 `IngestReport` 写入 store（便于可观测与调试）

### 1.4 IngestRunner 的实现细节

IngestRunner 需要满足：

- 严格 bounded：state slice 必须截断
- 输出强校验：对 `IngestReport` 做 schema 校验，不合法则降级为 `needs_reply=True` + `intent=reply` + `confidence=0`

prompt 模板建议放在 `src/bub/brain/ingest.py` 中以常量字符串形式维护（避免外部文件读写依赖）。

## 2. Phase 2：BrainJob 调度（tick + claim/lease + retry）

### 2.1 复用还是替换 scheduler

Bub 当前已有 APScheduler（JSON job store）。brain 的 jobs 更适合 SQLite（需要 claim/lease）。

建议：

- APScheduler 仅作为“tick 触发器”（每 N 秒调用一次 `brain.tick()`）。
- job 的真实队列与状态仍在 SQLite。

### 2.2 运行入口

提供一个新子命令（示意）：

```text
uv run bub brain
uv run bub telegram --brain
```

行为：

- `bub brain`：只跑 brain tick（适合把消息源放到其它地方）
- `bub telegram --brain`：在同进程启动 TelegramChannel + brain tick

### 2.3 job 执行策略

每个 job type 对应一个 handler：

- `notify`：发送 OutboundMessage（read-only）
- `run_task`：触发一次 respond（调用 runtime 或 subprocess）
- `watch_external`：查询外部状态（read-only）

必须实现：

- `max_concurrency`：并发上限（避免群聊风暴把机器打满）
- `backoff`：指数退避
- `max_retries`：超过后标记 failed 并发出通知

## 3. Phase 3：写操作 gate（BrainAction）

### 3.1 action lifecycle

```text
draft -> pending_approval -> approved -> executed
                 \-> rejected
```

### 3.2 审批入口

最小可用：

- CLI tool：`,brain.actions` / `,brain.approve action_id=<id>` / `,brain.reject ...`
- Telegram：允许在群里回复一个命令（只对 allowlist 用户生效）

### 3.3 执行与幂等

对每个写 action：

- `dedupe_key` 必填
- draft 中必须包含一个可嵌入的 idempotency token（例如 `X-Bub-Dedupe: <dedupe_key>`）
- 执行前必须先查是否已经存在该 token 的外部对象（如果外部系统支持查询）

## 4. 兼容性与迁移

### 4.1 默认关闭

新增配置项（示意）：

```text
BUB_BRAIN_ENABLED=false
BUB_BRAIN_LISTEN_ALL=false
BUB_BRAIN_SESSION_STRATEGY=thread|chat
BUB_BRAIN_ACTION_MODE=draft_only|auto
```

默认：

- `BUB_BRAIN_ENABLED=false`：完全不影响当前行为
- 开启 brain 后仍建议 `listen_all=false`，只处理 @bot/reply/command

### 4.2 数据迁移

SQLite store 初期可无迁移（create-if-not-exists），后续版本化：

- `PRAGMA user_version` 保存 schema version
- 每次启动执行迁移

## 5. 测试计划

新增 `pytest` 覆盖点（文件名示意）：

- `tests/test_brain_thread_routing.py`
  - reply chain 内不同 sender 路由到同 thread_key
  - 非 reply 消息各自独立 thread_key
- `tests/test_brain_ingest_bounded.py`
  - state slice 截断生效
  - ingest 输出 schema 校验与降级路径
- `tests/test_brain_job_lease.py`
  - running job lease 超时回收
  - retry/backoff 计算正确
- `tests/test_brain_action_gate.py`
  - 未批准不执行
  - 批准后只执行一次（dedupe_key 生效）

## 6. 验证方式（命令）

```bash
uv sync
uv run ruff check .
uv run mypy
uv run pytest -q
just docs-test
```

