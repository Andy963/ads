# Project-Wide Refactor Pass 35 - Design

## 设计原则

- 行为稳定优先：不改 `TaskStore` API 和任务生命周期，只收敛字段归一化规则。
- 单点规则：相同的 trim/null/default 语义只保留一个 helper 来源，避免 create/update/read 继续漂移。
- 兼顾旧数据：不仅规范新写入，还要在 mapper 读取旧记录时做同样的清洗，避免数据库历史脏值泄漏到上层。

## 方案

### 1. Shared normalization helpers

- 在 `server/tasks/storeImpl/normalize.ts` 增加共享 helper：
  - `normalizeNullableString()`
  - `normalizeTaskModel()`
- 这些 helper 负责 nullable string trim + empty-to-null，以及 `model` 的 `"auto"` fallback。

### 2. Task ops consolidation

- 在 `server/tasks/storeImpl/taskOps.ts` 中抽取局部 helper，统一处理：
  - create 路径的 `agentId` / `parentTaskId` / `threadId` / `createdBy` / `model`
  - update 路径的同类字段以及有限数字段 fallback
- 保留现有 queue/archive/status 规则，只把重复的字段归一化代码收敛起来。

### 3. Legacy row cleanup on read

- 在 `server/tasks/storeImpl/mappers.ts` 读取任务记录时复用同一批 helper。
- 这样即使数据库里已有历史空白字符串，上层读到的 `Task` 仍然是规范值。

### 4. Tests and documentation

- 在 `tests/tasks/taskStore.test.ts` 中新增：
  - create/update 字段归一化回归
  - legacy row 读取清洗回归
- 更新 `docs/REFACTOR.md`，记录本轮 touched 模块、测试和 backlog 状态。

## 风险与缓解

- 风险：某些历史调用依赖空白字符串而不是 `null`。
  - 缓解：本轮仅收敛任务身份字段，且这些字段在现有 UI/API 语义里本就应视为“缺失值”。
- 风险：helper 收敛后遗漏 create/update/read 某一路径。
  - 缓解：通过两类 `TaskStore` 测试同时覆盖新写入和 legacy row 读取。
