# Requirements

## 背景

当前 `TaskStore.getMessages(limit)` / `getConversationMessages(limit)` 的实现通过 SQL `ORDER BY created_at DESC LIMIT ?` 拉取最近 N 条记录后，在内存中 `reverse()` 以获得时间正序结果。该模式虽然正确，但：

- 意图不直观，阅读时容易误解返回顺序；
- 需要一次额外的数组翻转（对大 limit 不必要）。

此外，前端 `Task` 类型缺少后端已存在的 `parentTaskId` / `threadId` 字段，导致 TS 类型不完整。

## 目标

- 让 `limit` 查询直接返回“最近 N 条”的时间正序结果，去掉内存 `reverse()`。
- 保持对外行为不变（返回的数据范围与顺序与现状一致）。
- 补齐前端 `Task` 类型字段：`parentTaskId` / `threadId`（可选、可空）。
- 更新 `docs/REFACTOR.md` 记录本轮阅读与重构点。

## 非目标

- 不调整数据库 schema / migrations。
- 不变更消息/会话的业务语义（仅提升可读性与微小性能）。

## 约束

修改后需通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

若改动涉及前端（`web/`），额外通过：

```bash
npm run build
```

## 验收标准

- `TaskStore.getConversationMessages(conversationId, { limit: N })` 返回仍为时间正序，且为最近 N 条记录。
- 代码中不再对限量消息结果做 `reverse()`。
- 前端 `Task` 类型包含 `parentTaskId` / `threadId` 字段，TS 编译通过。
- `docs/REFACTOR.md` 有更新。

