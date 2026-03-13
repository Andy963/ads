# Project-wide Refactor Pass 36 - Graph Node Row Mapper

## Approach

- 新增 `server/graph/nodeRow.ts`，承载：
  - `NodeRow` 类型
  - `normalizeNodeRow()` 输入守卫
  - `normalizeSqlDate()` 日期归一 helper
  - `mapNodeRow()` 共享映射函数
- `server/graph/crud.ts` 只保留 graph CRUD 逻辑，删除本地重复的 node row 解析实现。
- `server/workspace/context/workflowContext/db.ts` 改为直接复用 `mapNodeRow()`，避免 workspace 只读路径继续保留一套近似但不完全相同的逻辑。
- `server/workspace/context/workflowContext/types.ts` 的 `NodeDbRow` 改为复用共享 `NodeRow` 类型，避免类型定义再次分叉。

## Tradeoffs

- 本轮不处理 `GraphEdge` mapper，也不推进更大范围的 graph service/store 拆分，保持改动最小。
- `normalizeNodeRow()` 仍只在 `crud.ts` 使用；workspace 只读路径读取的是受控 schema 行，因此直接复用 `mapNodeRow()` 即可。
