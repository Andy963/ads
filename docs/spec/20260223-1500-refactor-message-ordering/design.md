# Design

## 方案

### 1) 将“降序取最近 N 条 + 反转”改为 SQL 子查询表达

对 `task_messages` 与 `conversation_messages` 的限量查询改为：

- 内层：`ORDER BY created_at DESC LIMIT ?` 取最近 N 条
- 外层：`ORDER BY created_at ASC` 变为时间正序输出

从而：

- 语义更清晰（SQL 层直接表达“最近 N 条但按时间正序返回”）
- 去掉 JS 的 `reverse()`

### 2) 前端类型补齐

在 `web/src/api/types.ts` 的 `Task` 接口中补齐：

- `parentTaskId?: string | null`
- `threadId?: string | null`

不影响运行时，只提升类型一致性。

## 风险与控制

- 风险：极端情况下（同一 `created_at`）的行内顺序在不同排序表达下可能不稳定。
  - 控制：保持排序 key 与现状一致（仅使用 `created_at`），不引入额外排序字段，避免引入新的行为假设。

