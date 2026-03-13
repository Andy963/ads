# Project-wide Refactor Pass 36 - Graph Node Row Mapper

## Steps

1. 抽取共享 `GraphNode` row mapper 到 `server/graph/nodeRow.ts`。
2. 更新 `server/graph/crud.ts` 与 `server/workspace/context/workflowContext/db.ts` 使用共享 mapper。
3. 收敛 `NodeDbRow` 到共享 `NodeRow` 类型别名，减少重复类型定义。
4. 新增 `tests/graph/nodeRow.test.ts`，覆盖默认值、JSON/date/boolean/message id 解析与无效输入。
5. 更新 `docs/REFACTOR.md`，同步 reviewed/touched、docs pass 记录与未覆盖模块描述。
