# Project-wide Refactor Pass 41 - Web Route Helper Consolidation

## Approach

- 新增 `server/web/server/api/routes/shared.ts`，承载与具体 task 领域无关、但被多个 route 复用的 helper：
  - `resolveTaskContextOrSendBadRequest()`
  - `readJsonBodyOrSendBadRequest()`
  - `buildTaskAttachments()`
- 保留 `server/web/server/api/routes/tasks/shared.ts` 作为 task 子路由的兼容出口，只负责 task-specific helper 与对通用 helper 的 re-export，避免现有 import path 一次性大面积迁移。
- 在 `taskBundleDrafts.ts` 内进一步抽取局部私有 helper，用于：
  - draft id 校验
  - workspace-scope draft 读取
  - approval 后 queue promote/logging 收敛

## Tradeoffs

- 本轮不把 `taskBundleDrafts` 的“批准后 materialize tasks” 与 WS auto-approve 路径一起合并，因为那会扩大到 `handlePrompt.ts` 与更复杂的审批编排；当前先解决 route 层最明显的共享 helper 漂移。
- 保留 `tasks/shared.ts` 的 re-export 会多一层中转，但这是可接受的兼容成本，能换来更小的改动面与更平滑的后续迁移。
