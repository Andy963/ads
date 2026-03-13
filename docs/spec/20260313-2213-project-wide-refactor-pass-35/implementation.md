# Project-Wide Refactor Pass 35 - Implementation

## 实施步骤

1. 更新 `server/tasks/storeImpl/normalize.ts`
   - 增加共享的 nullable string / model normalization helper。

2. 更新 `server/tasks/storeImpl/taskOps.ts`
   - 收敛 create/update 中重复的任务身份字段归一化逻辑。
   - 保留现有状态、队列和归档语义不变。

3. 更新 `server/tasks/storeImpl/mappers.ts`
   - 在读取任务记录时复用共享 helper，清洗 legacy row。

4. 更新测试与文档
   - 在 `tests/tasks/taskStore.test.ts` 中补齐 create/update 与 legacy row 回归。
   - 更新 `docs/REFACTOR.md` 记录本轮 touched 模块、测试和 spec 目录。

## 变更文件

- `server/tasks/storeImpl/normalize.ts`
- `server/tasks/storeImpl/taskOps.ts`
- `server/tasks/storeImpl/mappers.ts`
- `tests/tasks/taskStore.test.ts`
- `docs/REFACTOR.md`
- `docs/spec/20260313-2213-project-wide-refactor-pass-35/*`

## 验证命令

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
