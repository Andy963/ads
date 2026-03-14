# Project-wide Refactor Pass 41 - Web Route Helper Consolidation

## Goal

- 收敛 Web API route 中与 task 领域无关的共享 helper，避免这些 helper 继续被埋在 `routes/tasks/` 子目录下，迫使其他 route 复制粘贴。
- 减少 `taskBundleDrafts` 与 `taskQueue` 路由中的重复上下文解析、JSON body 读取、attachment payload 组装与 queue promote 分支，保持现有 API 行为不变。

## Requirements

- 提取通用 route helper 到共享位置，并保证现有 task routes 仍可复用相同语义。
- `server/web/server/api/routes/taskBundleDrafts.ts` 必须改为复用共享 helper，且审批后任务广播的 attachment payload 结构保持不变。
- `server/web/server/api/routes/taskQueue.ts` 必须复用相同的 task context 解析错误处理，避免和其他 route 再次分叉。
- 不改动 task bundle draft 的 API contract、错误码、queue 启停语义或附件归属语义。
- 更新 `docs/REFACTOR.md`，记录本轮新阅读模块、重构点、后续 backlog 与新增 spec。
