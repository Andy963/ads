# Project-wide Refactor Pass 36 - Graph Node Row Mapper

## Goal

- 收敛 `GraphNode` 的 SQLite 行映射规则，避免 `server/graph/crud.ts` 与 `server/workspace/context/workflowContext/db.ts` 继续各自维护一份反序列化逻辑。
- 保持现有 graph/workflow 行为、接口与测试结果不变。

## Requirements

- 提供单一共享的 `GraphNode` row mapper，统一日期、JSON、布尔值与 nullable 字段解析语义。
- `crud.ts` 与 workspace workflow context 的读取路径必须复用同一 mapper。
- 补充最小回归测试，锁定共享 mapper 的默认值与异常输入行为。
- 更新 `docs/REFACTOR.md`，记录本轮已阅读模块、已落地重构点与未覆盖范围。
