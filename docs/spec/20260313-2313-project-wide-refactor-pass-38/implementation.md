# Project-wide Refactor Pass 38 - Chat Preference Persistence

## Steps

1. 新增 `client/src/lib/chatPreferences.ts`，集中 chat preference 的 normalize 与 storage key helper。
2. 更新 `client/src/app/tasks.ts`，让 persist 路径改用共享 helper。
3. 更新 `client/src/app/projectsWs/webSocketActions.ts`，让 restore 路径改用共享 helper。
4. 新增 `client/src/lib/chatPreferences.test.ts`，锁定 normalize 与 key 语义。
5. 更新 `docs/REFACTOR.md`，同步本轮 reviewed/touched、tests 与 spec。
