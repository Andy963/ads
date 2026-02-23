# Implementation

## 本次落地内容

1. 扩展 `src/utils/flags.ts`：
   - 新增 `parseOptionalBooleanFlag`
   - 新增 `parsePositiveIntFlag`
2. 迁移重复实现并删除局部解析函数：
   - `src/utils/activityTracker.ts`
   - `src/agents/hub.ts`
   - `src/agents/orchestrator.ts`
   - `src/systemPrompt/manager.ts`
   - `src/agents/tasks/taskCoordinator/helpers.ts`
   - `src/agents/tasks/supervisorPrompt.ts`
3. 更新 `docs/REFACTOR.md`，记录本轮阅读与重构点。

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
```
