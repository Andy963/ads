# Design

## 方案

- 在 `src/utils/flags.ts` 增加两个通用 helper：
  - `parseOptionalBooleanFlag(value)`：匹配 `0/1 true/false on/off yes/no`，否则返回 `undefined`
  - `parsePositiveIntFlag(value, defaultValue)`：`parseInt` 后检查 `finite && > 0`，否则返回 `defaultValue`
- 将语义一致的解析点迁移到共享实现，并删除局部重复函数：
  - `src/utils/activityTracker.ts`（`ADS_EXPLORED_*`）
  - `src/agents/hub.ts`（`ADS_TASK_*` 的并发/超时/重试参数）
  - `src/agents/orchestrator.ts`（skills/prefs toggles）
  - `src/systemPrompt/manager.ts`（reinjection enabled）
  - `src/agents/tasks/supervisorPrompt.ts`（supervisor prompt enabled）
  - `src/agents/tasks/taskCoordinator/helpers.ts`（保留 `parseBoolean` 导出，内部委托到共享实现，避免影响现有 import）

## 风险与控制

- 风险：不同模块对“非法值”的处理语义可能不一致。
  - 控制：只迁移与共享实现语义一致的点；对 `src/agents/tasks/verificationRunner.ts` 中“strict truthy”（非法值视为 false）的解析逻辑保持不动。
