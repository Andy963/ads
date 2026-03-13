# Project-Wide Refactor Pass 35 - Requirements

## 背景

继续执行小步可回滚的项目级重构。本轮聚焦 `TaskStore` 的任务字段归一化逻辑。当前 `createTask()` 与 `updateTask()` 对 `model`、`agentId`、`parentTaskId`、`threadId`、`createdBy` 等字段的 trim/null fallback 规则分散且不一致，旧数据读取也没有统一清洗，长期会让 store 持久化层积累空白字符串和脏值。

## 目标

1. Backend：把 `TaskStore` 任务身份字段的归一化规则收敛成共享 helper，减少 `taskOps` 与 mapper 的重复实现。
2. Backend：统一 create/update/read 三条路径的 `model` / nullable string 语义，避免空白字符串在任务记录中继续传播。
3. Tests：补齐 `TaskStore` 回归测试，覆盖 create/update 归一化和 legacy row 读取清洗。
4. 文档：更新 `docs/REFACTOR.md`，记录本轮已阅读/已重构模块、测试与 spec 目录。

## 非目标

- 不修改 `TaskStore` 对外 API。
- 不调整任务调度、归档或 purge 语义。
- 不引入数据库 schema 变更或数据迁移。

## 验收标准

1. `TaskStore` 在创建、更新、读取任务时，对空白 `model` 回退为 `"auto"`，并把空白 nullable string 归一为 `null`。
2. `TaskStore` 不再在 `taskOps` 和 mapper 中重复手写相同的 trim/null fallback 逻辑。
3. 新增/更新测试通过，且以下校验命令无失败：
   - `npx tsc --noEmit`
   - `npm run lint`
   - `npm test`
