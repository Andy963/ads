# ADR-0007: Queue Task Runs While Agent Is Busy

- Status: Accepted
- Date: 2026-01-30

## Context

Web UI 中同一时间可能存在两类“会触发 agent 执行”的入口：

- 右侧对话框（MainChat）的 prompt/command（WebSocket）
- 任务队列的执行（TaskQueue / task run endpoints）

如果在“当前正在对话/任务执行中”的情况下直接启动新的任务（无论是 “运行队列” 还是 “单独运行”），实际效果会表现为：

- 当前任务的对话/执行被打断（用户感知为中断/抢占）
- 任务执行过程与对话输出出现不可预测的交叉

我们需要一个硬规则来保证一致性：

> 任务只有在实际开始执行时才进入对话框/才交给 agent；若当前已有执行在进行，则新的运行请求必须排队等待。

## Decision

1. **项目互斥（per-workspace agent execution mutex）**
   - 使用按 `workspaceRoot` 分片的 keyed `AsyncLock`，串行化同一 workspace 内所有会触发 agent 执行的入口；
     跨 workspace 允许并行（见 ADR-0014）。

2. **任务执行期间持锁**
   - `OrchestratorTaskExecutor.execute()` 在整个任务执行周期内持锁（覆盖所有 step），防止在 step 边界被其他入口插入执行导致“抢占/中断”的用户体验。

3. **run 请求入队而非抢占**
   - `/api/task-queue/run` 与 `/api/tasks/:id/run` 在锁繁忙时不直接启动执行，而是把“启动动作”排队到锁后面执行，并立即返回 `202`（`queued: true`）。

## Consequences

- 正向：
  - 明确保证“同一时间只执行一个 agent 工作单元”，不会互相抢占或中断。
  - 用户在任务执行中点击 run 的结果变为“排队等待”，符合预期。

- 负向/风险：
  - 长任务会阻塞同一 workspace 内其他会触发执行的入口（包括 Worker Chat 与 Task Queue），需要用户主动等待或终止当前任务；
    Planner Chat（read-only）不受影响（见 ADR-0016）。

## Implementation Notes

- `src/tasks/executor.ts`: 将锁提升到整个 `execute()` 级别。
- `src/web/server/workspaceLockPool.ts`: keyed `AsyncLock` 的实现（按 workspace 分片）。
- `src/web/server/api/routes/taskQueue.ts`: `/api/task-queue/run` 在锁繁忙时返回 `202 queued` 并延后启动。
- `src/web/server/api/routes/tasks.ts`: `/api/tasks/:id/run` 在锁繁忙时返回 `202 queued` 并延后启动。
- `src/utils/asyncLock.ts`: 增加 `isBusy()` 以支持“是否需要立即排队”的判定。
