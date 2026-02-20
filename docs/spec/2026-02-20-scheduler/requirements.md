# Scheduler (compile-on-create)

## 背景

ADS 需要长期运行并周期性触发任务（如日报、巡检、对账等）。直接在每次触发时“重新理解自然语言指令”会引入不稳定性与不可审计性，因此采用 **compile-on-create**：在创建/编辑 schedule 时将自然语言编译为确定性的 `ScheduleSpec`，运行时仅执行已编译的 `compiledTask.prompt`。

## 目标

1. 支持通过自然语言创建 schedule，并在创建/编辑时完成编译、校验与持久化（compile-on-create）。
2. Scheduler 运行时仅消费持久化的编译产物（`ScheduleSpec.compiledTask.prompt`），不再重新解释自然语言 `instruction`。
3. 提供最小 Web API：创建/更新、启用/禁用、列表、查看最近 runs。
4. 并发安全与幂等：
   - 通过 lease/lock 避免多进程重复触发同一 schedule。
   - 通过 `external_id` 唯一约束保证同一 `(scheduleId, runAt)` 只会产生一次 run。
5. 对缺失信息（timezone/cadence/chat 绑定等）显式降级：`enabled=false` + `questions[]` 可被前端/调用方展示。

## 非目标

- 不实现完整 cron 语法（仅支持明确子集，详见设计）。
- 不实现 UI（本次仅提供 API；由后续前端消费）。
- 不实现实际通知发送（telegram/web delivery 仅存储意图，并提供集成点）。

## 需求

### 编译（compile step）

- 使用 project skill `scheduler-compile` 作为唯一编译规范来源。
- 编译调用 agent，要求返回 **单个 fenced `json` code block 且无其它文本**。
- 对编译结果执行：
  - fenced JSON 提取与 JSON.parse；
  - zod schema 校验；
  - 对运行时不支持的 schedule（cron 子集不匹配等）进行降级：`enabled=false` 并追加 `questions`。
- 解析/校验失败时允许有界重试（例如最多 2 次），重试 prompt 需包含失败原因与严格输出约束。

### 存储（SQLite）

- 在 `src/storage/migrations.ts` 新增迁移版本，创建表：
  - `schedules`：持久化 `instruction`、`spec_json`（编译产物）、`enabled`、`next_run_at`、lease 字段与元数据。
  - `schedule_runs`：持久化 `external_id`（唯一）、`run_at`、`status`、`task_id`、`result/error` 与时间戳。

### Runtime scheduler

- Tick loop：
  1. 选择 due schedules（`enabled=1` 且 `next_run_at <= now`）；
  2. 使用 DB lease（带 TTL）claim schedule，避免并发重复；
  3. 插入 `schedule_runs`（`external_id` 唯一幂等）；
  4. 以 **已编译 `compiledTask.prompt`** 入队创建普通任务（写入 `tasks` 表）；
  5. 推进 `next_run_at`；
  6. 周期性 reconcile：根据 `tasks` 终态更新 `schedule_runs` 终态与 `result/error`。

### API（最小集）

- `POST /api/schedules`：创建 schedule（编译并持久化）。
- `PATCH /api/schedules/:id`：更新 `instruction`（重新编译并持久化）。
- `POST /api/schedules/:id/enable`：启用（若编译产物包含 `questions` 或 cron 不受支持则拒绝/保持禁用）。
- `POST /api/schedules/:id/disable`：禁用。
- `GET /api/schedules`：列表。
- `GET /api/schedules/:id/runs`：最近 runs（limit）。

### 验收标准

- 可通过自然语言创建 schedule，创建时完成编译并持久化 `ScheduleSpec`。
- 触发时仅执行 `compiledTask.prompt`（不再读取/解释自然语言 `instruction`）。
- 相同 `(scheduleId, runAtIso)` 的重复触发被 `external_id` 唯一约束阻止。
- timezone/cadence 等缺失时：schedule 以 `enabled=false` 返回，并包含明确 `questions[]`。
- `npx tsc --noEmit`、`npm run lint`、`npm test` 通过（本次不改前端则不要求 `npm run build`）。

