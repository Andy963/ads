# Requirements

## 背景

- Web 的 task bundle draft 审批接口 `/api/task-bundle-drafts/:id/approve` 当前会在 handler 中获取 `taskCtx.lock.runExclusive(...)`。
- Task 执行（`orchestrator.invokeAgent(...)`）会持有同一个 workspace lock 直到任务结束。
- 结果：当 workspace 中有长任务运行时，审批请求会被锁阻塞，Web UI 进入 `busy=true` 并挂起，影响继续审批。

## 目标

- Draft 审批（Approve / Approve & Run）不应被执行锁阻塞；即使有 task 处于 `running`，审批仍应快速返回并创建 queued tasks。
- 保持执行安全：executor 的 workspace lock 语义保持不变（执行仍为全程独占）。
- 保持幂等：对同一个 draft 重复审批请求：
  - 不产生重复任务
  - 返回 HTTP 200 success，并返回已审批的 task ids
  - 已 `approved` 的 draft 上再次调用 `Approve & Run` 不应触发任何 queue side effects
- 并发健壮：当两个审批请求并发导致 `approveTaskBundleDraft(...)` 返回 `null`：
  - 若 draft 已是 `approved`：返回 HTTP 200 success（不重复触发 queue side effects）
  - 否则：返回清晰的冲突错误（例如 draft 状态不是 `approved`/`draft`）

## 非目标

- 不修改 executor 的 lock 策略。
- 不引入新的 DB schema / migration。
- 不改变 draft 的数据模型与状态枚举。

## 约束

- 不删除或覆盖任何数据库文件。
- 不执行 `git commit` / `git push`。
- 改动尽量小、可审阅、可回滚。
- 交付包含 spec 三件套，并在修改后保证以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- 当同一 workspace 有 task 处于 `running`（执行锁被占用）时：
  - 调用 draft approve 接口不会挂起
  - 返回 200，并创建 queued tasks
- 对同一个 draft：
  - approve 重复调用不会创建重复 tasks
  - approve 的响应始终返回同一组 task ids
  - `runQueue=true` 在 draft 已 approved 时不会触发 queue resume / promote side effects

