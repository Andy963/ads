# Project-wide Refactor Pass 37 - Web Workspace Root Resolution

## Approach

- 在 `server/web/server/api/routes/workspacePath.ts` 中新增两个共享层次：
  - `realpathOrOriginal()`：统一 `realpathSync` 的 non-throwing fallback；
  - `resolveWorkspaceRootFromDirectory()`：统一 `path.resolve -> realpath -> detectWorkspaceFrom -> realpath` 链路。
- `validateWorkspacePath()` 增加可选参数 `allowWorkspaceRootFallback`：
  - 默认保持当前 routes 兼容语义，当 detected workspace root 不在 allow list 时回退到 `resolvedPath`；
  - task queue 显式传 `false`，保留“detected root 越权即拒绝”的当前边界。
- `server/web/server/taskQueue/manager.ts` 删除本地重复的 `exists/stat/realpath/detectWorkspaceFrom` 逻辑，仅保留错误消息映射。
- `server/web/server/ws/server.ts` 只保留对共享 helper 的调用，确保 metadata `workspaceRoot` 与 API/task queue 走同一套归一规则。

## Tradeoffs

- 本轮只收敛 web 入口层，不继续向 `server/storage/database.ts` 下推 workspace root 真值，避免扩大验证面。
- `validateWorkspacePath()` 仍保留“workspace root 不在 allow list 时可回退到 resolved directory”的历史兼容语义，因为 `/api/paths/validate` 与 projects route 依赖它；task queue 用显式选项锁住更严格边界。
