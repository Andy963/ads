# Design

## Overview

采用“横切逻辑提取 + payload 解析收敛 + 共享校验复用”的小步重构策略，避免行为变更并降低重复代码维护成本。

## Backend

### `src/utils/commandRunner.ts`

- 新增可复用导出：
  - `isGitPushCommand(cmd, args)`
  - `assertCommandAllowed(cmd, args, allowlist)`
- `runCommand()` 改为复用 `assertCommandAllowed()`，保持原有错误语义不变。

### `src/bootstrap/commandRunner.ts`

- 删除本地 `hasPathSeparator` / `isGitPush` / `assertAllowlisted` 重复实现。
- 改为调用 `assertCommandAllowed()`，确保 bootstrap 与 host command runner 校验逻辑一致。

## Frontend

### `web/src/app/taskBundleDrafts.ts`

- 抽取 `withDraftRequest()` 包装登录检查、busy/error 生命周期与错误转换。
- 抽取 `fetchTaskBundleDrafts()`，供 load/update/delete 复用。
- 保持 action 输入输出签名不变。

### `web/src/app/projectsWs/projectActions.ts`

- 抽取字符串与时间戳归一化 helper：`normalizeString` / `normalizeTimestamp` / `normalizeChatSessionId`。
- 抽取项目归一化 helper：`normalizeStoredProject()` / `normalizeRemoteProject()`。
- `initializeProjects()` 与 `loadProjectsFromServer()` 改为复用共享 helper。

### `web/src/app/tasks/events.ts`

- 抽取 payload parsing helper：`parseTask` / `parseTaskMessage` / `parseCommandEvent` / `parseMessageDeltaEvent` / `parseTaskFailedEvent`。
- `onTaskEvent()` 保持事件分发结构不变，仅替换为集中解析后的数据对象。

## Risk & Mitigation

- 风险：helper 抽取导致状态更新顺序变化。
- 缓解：保持原先副作用顺序（例如 terminal cleanup、queue status 刷新顺序）不变，并通过全量回归命令验证。

- 风险：payload guard 可能影响异常输入路径。
- 缓解：仅在明显无效 payload 时提前返回；有效 payload 的业务路径保持一致。
