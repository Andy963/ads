# Project-wide Refactor Pass 41 - Web Route Helper Consolidation

## Steps

1. 新增 `server/web/server/api/routes/shared.ts`，承接通用 route helper。
2. 更新 `server/web/server/api/routes/tasks/shared.ts`，改为 re-export 通用 helper，仅保留 task-specific 逻辑。
3. 更新 `server/web/server/api/routes/taskQueue.ts` 与 `server/web/server/api/routes/taskBundleDrafts.ts`，复用通用 helper，并在 `taskBundleDrafts.ts` 内收敛本地重复分支。
4. 更新 `docs/REFACTOR.md`，同步 reviewed/touched、backlog 与新增 spec。
5. 运行 `npx tsc --noEmit`、`npm run lint`、`npm test` 验证行为未回归。
