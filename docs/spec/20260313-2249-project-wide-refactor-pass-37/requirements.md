# Project-wide Refactor Pass 37 - Web Workspace Root Resolution

## Goal

- 收敛 web 层的 workspace 路径校验与 workspace root 归一化逻辑，避免 API、task queue、WebSocket metadata 各自维护一套近似实现。
- 保持现有接口、错误语义与运行时行为不变。

## Requirements

- `server/web/server/api/routes/workspacePath.ts` 提供共享 helper，统一绝对路径、`realpath` 与 workspace root 检测逻辑。
- `server/web/server/taskQueue/manager.ts` 必须复用共享校验逻辑，并保持对“不允许的 workspace root”继续报错，而不是静默回退。
- `server/web/server/ws/server.ts` 必须复用共享 workspace root 归一化 helper，避免 WS metadata 与 API/task queue 漂移。
- 补充最小回归测试，覆盖：
  - 子目录输入归一到 git workspace root；
  - path validation 默认回退到 resolved directory 的兼容语义；
  - task queue 在 detected workspace root 越权时继续拒绝。
- 更新 `docs/REFACTOR.md`，记录本轮已阅读模块、落地重构点与新增 spec。
