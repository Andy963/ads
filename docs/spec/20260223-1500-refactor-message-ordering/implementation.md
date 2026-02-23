# Implementation

## 本次落地内容

1. 调整 SQLite statements：
   - `src/tasks/storeStatements.ts`
     - `getMessagesLimitedStmt`：改为子查询并返回时间正序
     - `getConversationMessagesLimitedStmt`：同上
2. 去掉内存反转逻辑：
   - `src/tasks/storeImpl/messageOps.ts`
   - `src/tasks/storeImpl/conversationOps.ts`
3. 补齐前端类型：
   - `web/src/api/types.ts`：为 `Task` 增加 `parentTaskId` / `threadId`
4. 更新重构追踪：
   - `docs/REFACTOR.md`

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

