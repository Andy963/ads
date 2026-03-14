# Project-wide Refactor Pass 40 - Scheduler Workspace Root Normalization

## Goal

- 收敛 `SchedulerRuntime` 对 workspace path 的处理，避免同一 workspace 的 root path 与 nested path 被视为不同调度域。
- 保持调度 API、任务执行结果与现有测试语义不变。

## Requirements

- `server/scheduler/runtime.ts` 必须在以下入口统一做 workspace root 归一化：
  - `registerWorkspace()`
  - `tickWorkspace()`
  - scheduler state/key payload 解析路径
- Liteque queue namespace、runner state map 与 in-memory workspace registry 不得再因为传入子目录路径而分叉。
- 补充最小回归测试，覆盖：
  - 以 nested workspace path 注册/触发调度时，仍能执行 root workspace 的 schedule；
  - `workspaces` / `states` 仅保留一个 canonical workspace root key。
- 更新 `docs/REFACTOR.md`，记录本轮已阅读模块、重构点、测试与 spec。
