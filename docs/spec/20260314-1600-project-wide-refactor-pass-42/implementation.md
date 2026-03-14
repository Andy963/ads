# Project-wide Refactor Pass 42 - Queue Lifecycle Helper Consolidation

## Steps

1. 新增 `server/web/taskQueue/control.ts`，承载 queue lifecycle 共享 helper。
2. 更新 `server/web/server/api/routes/taskQueue.ts`、`server/web/server/api/routes/taskBundleDrafts.ts`、`server/web/server/api/routes/tasks/taskById.ts`、`server/web/server/ws/handlePrompt.ts`、`server/web/server/taskQueue/manager.ts`，复用共享 helper 并保留各自业务副作用。
3. 新增 `tests/web/taskQueueControl.test.ts`，锁定 helper 的 start/pause 语义。
4. 更新 `docs/REFACTOR.md`，同步本轮 reviewed/touched、backlog 与 spec。
5. 运行 `npx tsc --noEmit`、`npm run lint`、`npm test`、`npm run build` 验证行为未回归。
