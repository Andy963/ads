# Project-wide Refactor Pass 40 - Scheduler Workspace Root Normalization

## Approach

- 在 `server/scheduler/runtime.ts` 内新增私有 helper `normalizeWorkspaceRoot()`，统一通过 `detectWorkspaceFrom()` 将外部传入的 workspace path 收敛为 canonical workspace root。
- `SchedulerRuntime` 的内存态统一以 canonical root 为 key：
  - `workspaces`
  - `states`
  - `inFlight`
  - queue/session namespace 的输入路径
- 保持 `ScheduleStore` / `TaskStore` / Liteque payload 结构不变，只修正 runtime 内部的 path identity 语义。

## Tradeoffs

- 本轮不改 `ScheduleStore` / `TaskStore` / route 层接口，因为它们已经各自通过 detector/database 路径做 root 归一化；问题集中在 runtime 的内存 key 与 queue namespace。
- 不做历史 Liteque queue rename/migration，避免扩大运行时写数据库的风险面；修复重点是阻止后续继续产生 path identity 分叉。
