# Project-wide Refactor Pass 42 - Queue Lifecycle Helper Consolidation

## Approach

- 新增 `server/web/taskQueue/control.ts`，只承载 queue lifecycle 的最小共享语义：
  - `startQueueInAllMode()`
  - `pauseQueueInManualMode()`
- helper 保持窄接口，仅依赖：
  - `runController.setModeAll()/setModeManual()`
  - `taskQueue.resume()/pause()`
  - `queueRunning`
- 各调用方继续保留自己的业务副作用：
  - promote queued tasks
  - `maybePauseAfterDrain()`
  - `taskQueue.start()`
  - route-specific error handling / broadcast / notifications

## Tradeoffs

- 本轮不继续把 `promoteQueuedTasksToPending()`、planner materialization、single-task run 或 terminal hooks 一起塞进 helper；那会把“纯 queue state 切换”与“业务副作用编排”重新耦合在一起。
- helper 只负责最基础的 queue state transition，因此 `taskById resume` 仍保留当前“只恢复 mode/queueRunning，不主动 promote”的现有语义。若未来确认这是产品缺陷，应以独立 spec 再处理。
