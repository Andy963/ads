# Task Queue: Promote queued tasks while running - Design

## Approach

- 在“创建 `queued` 任务”的后端入口处补齐触发：
  - 若 `taskCtx.queueRunning === true` 且 `taskCtx.runController.getMode() === 'all'`，则调用 `promoteQueuedTasksToPending(taskCtx)`。
- `promoteQueuedTasksToPending()` 已内建幂等/重入保护：
  - `queueRunning` / `dequeueInProgress` / `getActiveTaskId()` 检查；
  - 循环 `dequeueNextQueuedTask()`，并在有提升时 `notifyNewTask()` 唤醒执行器。

## Scope

- 覆盖会创建 `queued` 任务的 Web 路由：
  - `POST /api/tasks`（新建任务）
  - `POST /api/tasks/:id/rerun`（重跑任务）
  - `POST /api/task-bundle-drafts/:id/approve`（批准草稿但不显式 runQueue 时，若队列已在 running）

## Key Decisions

- 不在 `TaskQueue` 内部引入“自动提升 queued”的逻辑：
  - 避免破坏 `single` 模式（单任务运行期间不应推进其它 queued）。
- 不引入定时轮询：
  - 通过事件/入口触发即可覆盖主要卡死路径，减少后台噪声与不必要的 DB 操作。

## Risks

- `promoteQueuedTasksToPending()` 广播的 `task:updated` 不包含附件信息：
  - 前端现有 merge 策略应保留已有附件；若未来更改 merge 逻辑，需要回归验证。

## Open Questions

- None.

