# Project-wide Refactor Pass 37 - Web Workspace Root Resolution

## Steps

1. 在 `server/web/server/api/routes/workspacePath.ts` 抽取 `realpathOrOriginal()` 与 `resolveWorkspaceRootFromDirectory()` 共享 helper。
2. 为 `validateWorkspacePath()` 增加 `allowWorkspaceRootFallback` 选项，并保持默认兼容行为。
3. 更新 `server/web/server/taskQueue/manager.ts` 复用共享校验 helper，删除本地重复 workspace path/root 解析逻辑。
4. 更新 `server/web/server/ws/server.ts` 复用共享 workspace root 归一化 helper。
5. 更新 `tests/web/workspacePathValidation.test.ts`，新增 nested workspace root 与 fallback/reject 场景覆盖。
6. 新增 `tests/web/taskQueueManager.test.ts`，锁定 task queue 对 nested workspace 与 disallowed root 的行为。
7. 更新 `docs/REFACTOR.md`，同步本轮 reviewed/touched、tests 与 spec 记录。
