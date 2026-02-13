# Implementation

## 变更点

1. `web/src/app/tasks.ts`
   - 新增 `formatTaskNoticeLabel()`：
     - `title` exists => `"${title}"`
     - fallback => `${taskId.slice(0, 8)}`
   - `runSingleTask()` 的 queued/scheduled/scheduled(mock) notice 使用该 label。

2. `web/src/__tests__/single-task-run.test.ts`
   - 更新断言：notice 应包含任务 title（测试数据为 `Test Task`）。

## 回归关注点

- queued vs scheduled 两种分支文案均应包含 title。
- `ProjectRuntime.tasks` 未包含该任务时，应保持回退展示 id，不抛错。

