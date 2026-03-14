# Project-wide Refactor Pass 42 - Queue Lifecycle Helper Consolidation

## Goal

- 收敛 Web task queue 在 HTTP route、WS planner auto-approve 和 manager 初始化中的生命周期编排，避免 `setModeAll()` / `setModeManual()` / `resume()` / `pause()` / `queueRunning` 在多处继续手写。
- 在不改变 task queue 行为、错误码、auto-approve 语义和启动顺序的前提下，为后续继续整理 queue/materialization 边界打基础。

## Requirements

- 新增共享 helper，统一表达 “start queue in all mode” 与 “pause queue in manual mode”。
- `server/web/server/api/routes/taskQueue.ts`、`server/web/server/api/routes/taskBundleDrafts.ts`、`server/web/server/api/routes/tasks/taskById.ts`、`server/web/server/ws/handlePrompt.ts`、`server/web/server/taskQueue/manager.ts` 必须复用该 helper，而不是各自手写同样的 queue lifecycle 编排。
- 不改变以下语义：
  - `taskQueue/run` 仍在恢复后 promote queued tasks，并继续调用 `maybePauseAfterDrain()`
  - `taskById` 的 `resume` action 仍只恢复 queue mode，不额外改变其他副作用
  - planner auto-approve 仍在批准后恢复 queue 并 promote
  - manager auto-start 仍保持先设置 mode/queue state，再调用 `taskQueue.start()`
- 新增测试锁定共享 helper 语义，并更新 `docs/REFACTOR.md` 记录本轮 reviewed/touched、backlog 和 spec。
