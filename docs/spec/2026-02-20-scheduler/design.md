# Design: Scheduler compile-on-create

## 总览

核心原则：

- **Compile-on-create**：创建/编辑 schedule 时调用 agent 使用 `$scheduler-compile` skill 生成 `ScheduleSpec`，并进行严格解析 + zod 校验后持久化。
- **Run compiled only**：运行时只读取持久化的 `spec_json`，仅使用 `compiledTask.prompt` 创建任务入队执行。
- **Idempotent runs**：`schedule_runs.external_id` 唯一约束确保同一 run 只会创建一次。
- **Lease for concurrency**：`schedules.lease_until` + 条件更新作为轻量 lease，避免多进程重复触发。

## 数据模型（SQLite）

### schedules

- `id`：TEXT PK（uuid）
- `instruction`：TEXT（原始自然语言输入）
- `spec_json`：TEXT（完整 `ScheduleSpec` JSON）
- `enabled`：INTEGER（0/1，运行开关）
- `next_run_at`：INTEGER（ms epoch，UTC）
- `lease_owner`：TEXT（nullable）
- `lease_until`：INTEGER（ms epoch，UTC，nullable）
- `created_at` / `updated_at`：INTEGER（ms）

查询/索引：

- `enabled,next_run_at` 用于 due 扫描
- `lease_until` 用于并发 claim

### schedule_runs

- `id`：INTEGER PK AUTOINCREMENT
- `schedule_id`：TEXT（FK -> schedules.id）
- `external_id`：TEXT UNIQUE（例如 `sch:<scheduleId>:<runAtIso>`）
- `run_at`：INTEGER（ms epoch, UTC）
- `status`：TEXT（`queued|running|completed|failed|cancelled`）
- `task_id`：TEXT（nullable；默认使用 `external_id` 作为 taskId 以便幂等创建）
- `result`：TEXT（nullable，来自 `tasks.result`）
- `error`：TEXT（nullable，来自 `tasks.error`）
- `created_at` / `started_at` / `completed_at`：INTEGER（ms，nullable）

## Cron 支持范围

为避免引入新依赖，运行时仅支持 `ScheduleSpec` 的一个明确子集（并在编译校验阶段对不支持的表达式降级为 `enabled=false`）：

- 仅支持 5-field cron：`min hour dom mon dow`
- `dom` 与 `mon` 必须为 `*`
- `hour`：`*` 或 `0-23` 数字
- `min`：`0-59` 数字，或 `*/N`（`N` 必须整除 60）
- `dow`：`*` 或数字/范围/列表（0/7=Sun, 1=Mon ... 6=Sat），例如 `1-5`、`1,3,5`

该子集覆盖：

- 每日定时（`MM HH * * *`）
- 工作日定时（`MM HH * * 1-5`）
- 每周定时（`MM HH * * 1`）
- 每 N 分钟（`*/15 * * * *` 等，N|60）

## next_run_at 计算

- `next_run_at` 始终存储为 UTC ms epoch。
- 计算基于 `schedule.timezone`（IANA TZ，如 `Asia/Shanghai`），使用 `Intl.DateTimeFormat(..., { timeZone })` 获取当地时间 parts，并通过迭代校正将“当地 wall-clock 时间”转换回 UTC timestamp（处理 DST/offset）。
- 语义：`next_run_at` 必须严格大于基准时间（避免同一分钟重复触发）。

## 并发与幂等

### Lease claim

Tick 中对每个 due schedule 使用单条条件更新 claim：

`UPDATE schedules SET lease_owner=?, lease_until=? WHERE id=? AND enabled=1 AND next_run_at<=? AND (lease_until IS NULL OR lease_until<=?)`

`changes==1` 表示 claim 成功。lease TTL（例如 30s）避免进程崩溃导致永久锁。

### external_id

- `external_id = "sch:<scheduleId>:<runAtIso>"`
- `schedule_runs.external_id` UNIQUE
- 创建 run 使用 `INSERT ...`，冲突表示 run 已存在（重复触发被阻止）。

## 任务入队（TaskQueue）

- Scheduler 仅将任务写入现有 `tasks` 表（普通任务），其 `prompt` 固定为 `compiledTask.prompt`。
- `task_id` 默认使用 `external_id`，保证即使 scheduler 重试也不会创建重复 task。
- Run 状态通过轮询 reconcile（JOIN `tasks` 表读取终态）更新到 `schedule_runs`。

## API 设计

所有 schedule API 以 `workspace` query param scope（复用现有 `resolveTaskContext(url)`）：

- 创建/编辑：compile-on-create，返回 `{ schedule, spec }`（含 `questions`）。
- enable：仅当 `questions.length===0` 且 cron 被运行时支持才允许置 `enabled=1` 并计算/写入 `next_run_at`。
- disable：置 `enabled=0`，清空 `next_run_at`（避免被 due 扫描）。
- list：返回 schedules 基础信息（含 `enabled/next_run_at/questions`）。
- runs：返回最近 runs（limit，默认 50）。

## 通知（集成点）

`ScheduleSpec.delivery` 与 `policy` 被完整持久化，但运行时不直接发送通知；在 `schedule_runs` 进入终态时提供一个 hook（后续可复用现有 telegram notifier）。

