# Project-wide Refactor Pass 40 - Scheduler Workspace Root Normalization

## Steps

1. 在 `server/scheduler/runtime.ts` 提炼 `normalizeWorkspaceRoot()`，统一 runtime 内部的 workspace key。
2. 更新 `registerWorkspace()`、`getState()`、`tickWorkspace()` 与 payload 解析，确保 nested path 与 root path 命中同一 scheduler state。
3. 更新 `tests/scheduler/schedulerRuntime.test.ts`，补充 nested workspace path 的回归测试。
4. 更新 `docs/REFACTOR.md`，同步本轮 reviewed/touched、tests 与新增 spec。
