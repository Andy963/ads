# Design

## Overview

本轮采用“共享 helper 收敛 + 常量来源统一 + 小幅性能优化”的策略，在不改变业务语义的前提下提升可维护性。

## Backend

### `src/web/taskNotifications/store.ts`

- 新增共享 helper：
  - `normalizeText()`
  - `parseFiniteNumber()`
  - `parseOptionalTimestamp()`
  - `parseNonNegativeInteger()`
  - `resolveNow()`
  - `resolvePositiveInteger()`
- 新增终态定义与判断：
  - `TERMINAL_TASK_STATUSES`
  - `TERMINAL_TASK_STATUSES_SQL`
  - `isTaskTerminalStatus()`
- `mapRow()`、`listDueTaskNotifications()`、`claimTaskNotificationSendLease()` 改为复用共享 helper，减少分散的手写解析/判定。

### `src/web/taskNotifications/telegramNotifier.ts`

- 复用 `isTaskTerminalStatus()` 做终态判定，避免与 store 查询条件漂移。
- 引入 `telegramTimestampFormatterCache`，按时区缓存 `Intl.DateTimeFormat`，减少频繁重建。

## Frontend

### `web/src/lib/live_activity.ts`

- 新增 `CATEGORY_LABEL_BY_KIND` 映射替代多分支 `switch`。
- 新增 helper：
  - `resolveMaxSteps()`
  - `consumePendingCommand()`
  - `findLastStepWithoutCommand()`
- `createLiveActivityWindow()` / `ingestExploredActivity()` / `ingestCommandActivity()` 改为复用 helper，主流程更聚焦。

## Tests

- `tests/web/taskTerminalTelegramNotifications.test.ts`：新增 `isTaskTerminalStatus()` 大小写与非法输入回归覆盖。
- `web/src/lib/live_activity.test.ts`：新增 max steps fallback、pending command 覆盖与 unknown category 归一化渲染覆盖。

## Risk & Mitigation

- 风险：归一化 helper 抽取可能改变边界输入处理。
- 缓解：保持原有默认值策略，并补充针对大小写、非法值、fallback 的回归测试。

- 风险：formatter 缓存可能受环境变量变化影响。
- 缓解：按“解析后的时区字符串”作为缓存键，时区变化会走新键，不影响现有行为。
