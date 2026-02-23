# Task Queue: Promote queued tasks while running - Requirements

## 背景

- Web 任务队列使用两阶段状态：`queued`（已入队，尚未可执行）与 `pending`（可被执行器 claim）。
- 当前 `TaskQueue` 只会执行 `pending`（`claimNextPendingTask()`）；`queued -> pending` 的提升由 `promoteQueuedTasksToPending()` 负责。
- 现有提升触发点覆盖了“启动队列”与“任务终态（completed/failed/cancelled）”等场景，但缺少“队列已在 running 且此刻空闲（无 active task），此时新增 queued 任务”的触发。
- 结果是：UI 显示队列运行中，但任务长期停留在 `queued`，看起来像“锁没释放/队列卡死”，需要手动暂停/运行队列才能恢复。

## 目标

- 当队列处于 `queueRunning=true` 且运行模式为 `all` 时：
  - 新创建的 `queued` 任务应被及时提升为 `pending` 并唤醒队列执行（无需用户手动切换队列开关）。
- 维持 `single` 模式语义：
  - 单任务运行期间不应提升其它 `queued` 任务（避免任务状态变化但不会被执行的误导）。

## 非目标

- 不修改任务数据模型与数据库 schema（不新增 migration）。
- 不改变 `TaskQueue` 执行逻辑（仍只执行 `pending`）。
- 不新增/修改前端 UI（仅修复后端触发逻辑）。

## 约束

- 不删除或覆盖任何数据库文件。
- 不执行 `git commit` / `git push`。
- 改动尽量小、可审阅、可回滚。
- 交付前需保证以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- 在队列已运行且空闲时，通过 Web API 创建/重跑/批准产生的 `queued` 任务会被自动提升为 `pending` 并开始执行。
- 当 `queueRunning=false` 或运行模式为 `single` 时，不会因为新增 `queued` 任务而触发批量提升。
- 广播的 `task:updated` 事件不会导致已有附件信息丢失（前端应保持 merge 语义）。

